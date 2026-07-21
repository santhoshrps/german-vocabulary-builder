"""World-level pipeline commands (MS2-FR-30): `seed` and `drift`.

  python3 world.py seed  [--env dev|test] [--dry-run] [--skip-media]
      Bootstrap a world's DATA in one command: publish every word table
      (sync.py), then the media catalog/packs/channel (media_publish.py),
      then verify the write worker's /health identity. PROD IS REFUSED —
      production is bootstrapped once, by hand, per the staging doctrine
      (dev publish → prod beta → promote).

  python3 world.py drift [--from dev] [--to prod]
      Read-only: what the FROM world has that TO hasn't received —
      per-table word ids (new / changed / only-in-TO), and the media
      channel delta (versions, packs, catalogs). No confirmation needed;
      nothing is written anywhere.

Both commands resolve environments through sync/envs.py (MS2-FR-30: the
registry is the only source of targets; mixed configurations are
unrepresentable).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))

import envs
import media_delivery
from registry import TABLES as V2_TABLES

_SYNC_DIR = Path(__file__).parent
CHANNELS_PREFIX = "media/channels"
WORD_STATE_TABLES = list(V2_TABLES.keys())
# Best-effort extras: diffed when the worker serves them, reported as absent otherwise.
OPTIONAL_STATE_TABLES = ["translations", "id_aliases"]


# ---------------------------------------------------------------------------
# Signed state reads (drift is read-only: /state/<table> only)
# ---------------------------------------------------------------------------

def _signed_get(env: envs.Environment, path: str, timeout: float = 60.0) -> httpx.Response:
    """One signed GET against an environment's WRITE worker. Self-contained (no
    sync.py module globals) so two environments can be read in one process."""
    timestamp = str(int(time.time()))
    body_hash = hashlib.sha256(b"").hexdigest()
    canonical = f"GET\n{path}\n{timestamp}\n{body_hash}"
    signature = hmac.new(env.api_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return httpx.get(
        f"{env.worker_url}{path}",
        headers={"X-Timestamp": timestamp, "X-Signature": signature},
        timeout=timeout,
    )


def _state(env: envs.Environment, table: str) -> dict[str, str] | None:
    """id -> content_hash for one table; None when the worker has no such state."""
    response = _signed_get(env, f"/state/{table}")
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


def _channel_manifest(env: envs.Environment, channel: str) -> dict | None:
    """The environment's channel manifest, read straight from its bucket.
    Call ONLY while this env's credentials are the loaded ones."""
    client = media_delivery.r2_client()
    try:
        obj = client.get_object(Bucket=env.r2_bucket, Key=f"{CHANNELS_PREFIX}/{channel}.json")
        return json.loads(obj["Body"].read())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# drift — what FROM has that TO hasn't received (MS2-FR-30)
# ---------------------------------------------------------------------------

def drift(from_name: str, to_name: str) -> int:
    if from_name == to_name:
        print(f"drift: FROM and TO are both {from_name!r} — nothing to compare")
        return 2

    # Environments are loaded SEQUENTIALLY: envs.load_environment exports each
    # world's credentials, so every read for one env happens before the next load.
    print(f"drift: {from_name} → {to_name}\n")
    env_from = envs.load_environment(from_name)
    words_from = {t: _state(env_from, t) for t in WORD_STATE_TABLES + OPTIONAL_STATE_TABLES}
    media_from = {ch: _channel_manifest(env_from, ch) for ch in ("live", "beta")}

    env_to = envs.load_environment(to_name)
    words_to = {t: _state(env_to, t) for t in WORD_STATE_TABLES + OPTIONAL_STATE_TABLES}
    media_to = {ch: _channel_manifest(env_to, ch) for ch in ("live", "beta")}

    ahead = 0

    print("── words ──")
    for table in WORD_STATE_TABLES + OPTIONAL_STATE_TABLES:
        a, b = words_from[table], words_to[table]
        if a is None and b is None:
            continue
        if a is None or b is None:
            side = from_name if a is None else to_name
            print(f"  {table:14} state endpoint absent in {side} — cannot compare")
            continue
        new = sorted(set(a) - set(b))
        changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])
        only_to = sorted(set(b) - set(a))
        ahead += len(new) + len(changed)
        if new or changed or only_to:
            print(f"  {table:14} {len(new)} new, {len(changed)} changed"
                  + (f", {len(only_to)} only in {to_name}" if only_to else ""))
            for key in (new + changed)[:5]:
                print(f"      {key}{'  (changed)' if key in changed else ''}")
            if len(new) + len(changed) > 5:
                print(f"      … and {len(new) + len(changed) - 5} more")
        else:
            print(f"  {table:14} in sync ({len(a)} rows)")

    print("\n── media (live channel) ──")
    a, b = media_from["live"], media_to["live"]
    if a is None:
        print(f"  {from_name} has no live channel — nothing to receive")
    elif b is None:
        ahead += len(a.get("packs", {}))
        print(f"  {to_name} has NO live channel; {from_name} is at version {a['version']} "
              f"with {len(a.get('packs', {}))} packs — everything is drift")
    else:
        print(f"  versions: {from_name}={a['version']}/{a['generation']}  "
              f"{to_name}={b['version']}/{b['generation']}")
        packs_a = {name: meta.get("key") for name, meta in a.get("packs", {}).items()}
        packs_b = {name: meta.get("key") for name, meta in b.get("packs", {}).items()}
        missing = sorted(name for name, key in packs_a.items() if packs_b.get(name) != key)
        ahead += len(missing)
        if missing:
            print(f"  {len(missing)} pack(s) {to_name} hasn't received:")
            for name in missing[:8]:
                print(f"      {name}")
            if len(missing) > 8:
                print(f"      … and {len(missing) - 8} more")
        cats_a = {k: m.get("sha") for k, m in a.get("catalogs", {}).items()}
        cats_b = {k: m.get("sha") for k, m in b.get("catalogs", {}).items()}
        cat_diff = sorted(k for k, sha in cats_a.items() if cats_b.get(k) != sha)
        ahead += len(cat_diff)
        if cat_diff:
            print(f"  catalog shard(s) differing: {', '.join(cat_diff)}")
        if not missing and not cat_diff:
            print("  media in sync")

    print(f"\ndrift total: {ahead} item(s) {to_name} hasn't received from {from_name}")
    return 0


# ---------------------------------------------------------------------------
# seed — bootstrap a world's data in one command (MS2-FR-30)
# ---------------------------------------------------------------------------

def _run(step: str, cmd: list[str]) -> None:
    print(f"\n━━ seed: {step} ━━\n  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=_SYNC_DIR)
    if result.returncode != 0:
        raise SystemExit(f"seed: {step} FAILED (exit {result.returncode}) — world left as-is; "
                         f"re-running seed is safe (every step is idempotent)")


def seed(env_name: str, *, dry_run: bool, skip_media: bool) -> int:
    if env_name == "prod":
        # The staging doctrine (MS2-FR-30): production receives content through
        # dev publish → prod BETA → promote, each with its typed confirmation —
        # never through a bulk bootstrap.
        raise SystemExit("seed: refusing prod — bootstrap dev/test; production is promoted into")
    env = envs.load_environment(env_name)   # validates the overlay before any subprocess
    print(f"seed: {env.name} ({env.worker_url})" + ("  [DRY RUN]" if dry_run else ""))

    py = sys.executable
    dry = ["--dry-run"] if dry_run else []
    _run("words (all tables, translations, aliases)", [py, "sync.py", "--env", env.name, *dry])
    if skip_media:
        print("\n━━ seed: media SKIPPED (--skip-media) ━━")
    else:
        _run("media (catalog + packs + live channel)",
             [py, "media_publish.py", "publish", "--env", env.name, "--channel", "live",
              *dry, "--skip-missing-media"])

    if not dry_run:
        health = httpx.get(f"{env.worker_url}/health", timeout=30.0)
        health.raise_for_status()
        body = health.json()
        reported = body.get("env") or body.get("environment")
        if reported and reported != env.name:
            raise SystemExit(f"seed: /health reports env {reported!r} ≠ {env.name!r} — "
                             f"WORLD MISMATCH, investigate before trusting this seed")
        print(f"\nseed: /health ok — {json.dumps(body)[:200]}")
    print(f"\nseed: {env.name} complete")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    seed_p = sub.add_parser("seed", help="bootstrap a dev/test world's data in one command")
    seed_p.add_argument("--env", choices=[n for n in envs.environment_names() if n != "prod"],
                        default=envs.DEFAULT_ENV)
    seed_p.add_argument("--dry-run", action="store_true")
    seed_p.add_argument("--skip-media", action="store_true",
                        help="words only (media publish needs the local caches)")

    drift_p = sub.add_parser("drift", help="what FROM has that TO hasn't received (read-only)")
    drift_p.add_argument("--from", dest="from_env", choices=envs.environment_names(), default="dev")
    drift_p.add_argument("--to", dest="to_env", choices=envs.environment_names(), default="prod")

    args = parser.parse_args()
    if args.command == "seed":
        raise SystemExit(seed(args.env, dry_run=args.dry_run, skip_media=args.skip_media))
    raise SystemExit(drift(args.from_env, args.to_env))


if __name__ == "__main__":
    main()
