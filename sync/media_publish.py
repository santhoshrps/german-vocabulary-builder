"""Media publisher v2 (MS2-FR-3/4/5, 20, 25-27): catalog + immutable packs +
channel manifests, per environment, with the v2 identity re-label.

WHAT IT PUBLISHES (to the target environment's media bucket, sync/envs.py):
  audio/packs/<name>-<sha12>.pack     immutable pack objects (content-suffixed keys;
                                      a changed pack is a NEW object, never an overwrite)
  media/catalog/<kind>-<sha12>.json   immutable per-kind catalogs (audio, image):
                                      entries keyed by v2 media id with type/level/
                                      bytes/hash/free — the per-file truth (MS2-FR-3)
  media/channels/<channel>.json       channel manifest: a POINTER SET {version,
                                      generation, packs{name:{key,...}}, scopes,
                                      catalogs} — beta and live are two pointers
                                      into the same immutable object space
  media/channels/history/<...>.json   every previous live manifest (rollback, MS2-FR-20)
  audio/manifest.json                 the legacy client manifest, written ONLY when a
                                      channel becomes live (publish --channel live, or
                                      promote) — today's app keeps working unchanged

RE-LABEL (WD-ID-5): descriptors and image records are produced by the UNCHANGED
legacy machinery (audio_sync collect + overrides; image_decisions store), keyed by
v1 ids — then re-labeled to v2 ids through the alias map from the spreadsheet
dataset. Nothing is re-synthesized, no cache or decision file is mutated; audio
bytes come from the local audio cache, image masters from the local image cache.

PROMOTE / ROLLBACK: `promote` copies the beta pointer set to live (+ legacy
manifest + history); `rollback` restores the previous live pointer set from
history. Both are manifest-only operations — pack/catalog objects are immutable,
so a rolled-back manifest's references are always intact (GC of unreferenced
objects is a later, grace-windowed step).

Usage:
  python media_publish.py publish  [--env dev] [--channel live|beta] [--dry-run]
  python media_publish.py promote  [--env prod]
  python media_publish.py rollback [--env prod]
  python media_publish.py status   [--env dev]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import audio_sync
import dataset as dataset_mod
import envs
import image_config
import image_decisions
import media_delivery
import sync as legacy_sync
from registry import TABLES

logger = logging.getLogger("media_publish")

CHANNELS = ("live", "beta")
LEGACY_MANIFEST_KEY = media_delivery.MANIFEST_KEY          # audio/manifest.json
PACKS_PREFIX = media_delivery.PACKS_PREFIX                 # audio/packs
CATALOG_PREFIX = "media/catalog"
CHANNELS_PREFIX = "media/channels"
GENERATION_KEY = "media/generation.json"


class PublishError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Alias map + re-label
# ---------------------------------------------------------------------------

def load_alias_map() -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """(old_id -> new_id, new_id -> v2 core row) from the spreadsheet dataset."""
    old_to_new: dict[str, str] = {}
    core_by_new: dict[str, dict[str, Any]] = {}
    for table in TABLES:
        ds = dataset_mod.read_dataset(table, skip_invalid=True)
        for alias in ds.aliases:
            old_to_new[alias["id"]] = alias["new_id"]
        for row in ds.core:
            row["_table"] = table
            core_by_new[row["id"]] = row
    return old_to_new, core_by_new


def relabel(media_id: str, old_to_new: dict[str, str]) -> str | None:
    """Map a legacy media id (with optional _plural/_sentence suffix) to v2."""
    base, sep, suffix = media_id.partition("_")
    new_base = old_to_new.get(base)
    if new_base is None:
        return None
    return f"{new_base}{sep}{suffix}" if sep else new_base


# ---------------------------------------------------------------------------
# Collect members (legacy machinery, v2 labels)
# ---------------------------------------------------------------------------

def collect_audio(old_to_new: dict[str, str], skip_missing: bool
                  ) -> tuple[dict[str, list[media_delivery.Member]], list[dict[str, Any]]]:
    """Audio packs + catalog entries, re-labeled to v2 ids. Bytes come from the
    local audio cache (keyed by LEGACY id — untouched); a stale/missing clip is a
    hard error unless --skip-missing-media (run audio_sync first, root cause)."""
    words = audio_sync.collect_words(skip_invalid=True)  # legacy ids, overrides applied
    index = json.loads(audio_sync.INDEX_PATH.read_text()) if audio_sync.INDEX_PATH.exists() else {}

    missing: list[str] = []
    packs: dict[str, list[media_delivery.Member]] = {}
    entries: list[dict[str, Any]] = []
    unaliased = 0
    for w in words:
        legacy_id = w["id"]
        new_id = relabel(legacy_id, old_to_new)
        if new_id is None:
            unaliased += 1
            continue
        path = audio_sync._cache_path(legacy_id)
        if index.get(legacy_id) != w["audio_hash"] or not path.exists():
            missing.append(legacy_id)
            continue
        data = path.read_bytes()
        w2 = dict(w, id=new_id)
        full_pack, free_pack = audio_sync._packs_for(w2)
        member: media_delivery.Member = (new_id, w["audio_hash"], data)
        packs.setdefault(full_pack, []).append(member)
        if w["free"]:
            packs.setdefault(free_pack, []).append(member)
        entries.append({
            "id": new_id, "kind": w["variant"] if w["variant"] != "singular" else "word",
            "type": w["kind"], "level": w["level"], "free": int(w["free"]),
            "hash": w["audio_hash"], "bytes": len(data),
        })
    if unaliased:
        logger.warning("audio: %d clip(s) belong to rows without a v2 identity (skipped sheet rows) — left out", unaliased)
    if missing:
        msg = (f"audio: {len(missing)} clip(s) missing or stale in the local cache "
               f"(first: {missing[:5]}) — run audio_sync.py first")
        if not skip_missing:
            raise PublishError(msg)
        logger.warning("%s (--skip-missing-media: continuing without them)", msg)
    return packs, entries


def collect_images(old_to_new: dict[str, str], skip_missing: bool
                   ) -> tuple[dict[str, list[media_delivery.Member]], list[dict[str, Any]]]:
    """Image packs + catalog entries from the approved decisions store, re-labeled.
    Masters come from the local image cache (keyed by content hash — id-free)."""
    nouns, _, _ = legacy_sync.read_excel("nouns", skip_invalid=True)
    by_id = {n["id"]: n for n in nouns}
    store = image_decisions.load()

    missing: list[str] = []
    packs: dict[str, list[media_delivery.Member]] = {}
    entries: list[dict[str, Any]] = []
    for legacy_id, rec in image_decisions.approved(store).items():
        noun = by_id.get(legacy_id)
        new_id = relabel(legacy_id, old_to_new)
        if noun is None or new_id is None:
            continue
        h = rec["content_hash"]
        path = image_config.CACHE_DIR / f"{h}.{image_config.FILE_EXT}"
        if not path.exists():
            missing.append(legacy_id)
            continue
        data = path.read_bytes()
        member: media_delivery.Member = (new_id, h, data)
        packs.setdefault(image_config.pack_name(noun["level"]), []).append(member)
        if noun.get("free"):
            packs.setdefault(image_config.FREE_PACK_NAME, []).append(member)
        entries.append({
            "id": new_id, "kind": "image", "type": "noun",
            "level": (noun.get("level") or "").strip().lower(),
            "free": int(noun.get("free") or 0), "hash": h, "bytes": len(data),
        })
    if missing:
        msg = (f"images: {len(missing)} approved master(s) missing from the local cache "
               f"(first: {missing[:5]}) — run image_sync.py first")
        if not skip_missing:
            raise PublishError(msg)
        logger.warning("%s (--skip-missing-media: continuing without them)", msg)
    return packs, entries


# ---------------------------------------------------------------------------
# Immutable object publish
# ---------------------------------------------------------------------------

def _sha12(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def _existing_keys(client, bucket: str, prefix: str) -> set[str]:
    keys: set[str] = set()
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.add(obj["Key"])
    return keys


def _put_verified(client, bucket: str, key: str, data: bytes, content_type: str) -> None:
    """Upload + write-verify (MS2-FR-5): single-part R2 ETag is the MD5 of the
    bytes — HEAD it back and compare, so a corrupted upload can never go live."""
    client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
    etag = client.head_object(Bucket=bucket, Key=key)["ETag"].strip('"')
    local_md5 = hashlib.md5(data).hexdigest()
    if etag != local_md5:
        raise PublishError(f"write-verify FAILED for {key}: etag {etag} != md5 {local_md5}")


def _get_json(client, bucket: str, key: str) -> dict[str, Any] | None:
    try:
        return json.loads(client.get_object(Bucket=bucket, Key=key)["Body"].read())
    except Exception:  # noqa: BLE001
        return None


def _ensure_generation(client, bucket: str) -> str:
    gen = _get_json(client, bucket, GENERATION_KEY)
    if gen and gen.get("generation"):
        return str(gen["generation"])
    generation = hashlib.sha256(f"{bucket}|{time.time()}".encode()).hexdigest()[:12]
    _put_verified(client, bucket, GENERATION_KEY,
                  json.dumps({"generation": generation}).encode(), "application/json")
    return generation


def publish(env: envs.Environment, channel: str, *, dry_run: bool, skip_missing: bool) -> None:
    logger.info("→ %s / channel %s (bucket %s)", env.name, channel, env.r2_bucket)
    old_to_new, _core = load_alias_map()
    audio_packs, audio_entries = collect_audio(old_to_new, skip_missing)
    image_packs, image_entries = collect_images(old_to_new, skip_missing)

    packs = {**audio_packs, **image_packs}
    pack_bytes: dict[str, bytes] = {}
    pack_meta: dict[str, dict[str, Any]] = {}
    for name, members in packs.items():
        data = media_delivery.build_pack_bytes(members)
        meta = media_delivery.pack_meta(members, data)
        meta["key"] = f"{PACKS_PREFIX}/{name}-{_sha12(data)}.pack"
        pack_bytes[name] = data
        pack_meta[name] = meta

    catalogs: dict[str, dict[str, Any]] = {}
    catalog_bytes: dict[str, bytes] = {}
    for kind, entries in (("audio", audio_entries), ("image", image_entries)):
        body = json.dumps(
            {"v": 1, "kind": kind, "entries": sorted(entries, key=lambda e: e["id"])},
            separators=(",", ":"),
        ).encode()
        catalogs[kind] = {
            "key": f"{CATALOG_PREFIX}/{kind}-{_sha12(body)}.json",
            "sha": hashlib.sha256(body).hexdigest(),
            "bytes": len(body), "count": len(entries),
        }
        catalog_bytes[kind] = body

    legacy_manifest = media_delivery.build_manifest(
        {n: {k: v for k, v in m.items()} for n, m in pack_meta.items()}
    )
    version = legacy_manifest["version"]

    total = sum(len(b) for b in pack_bytes.values())
    logger.info("  %d packs (%.1f MB), catalogs: audio %d / image %d entries, version %s",
                len(packs), total / 1e6, len(audio_entries), len(image_entries), version)
    if dry_run:
        logger.info("[DRY RUN] nothing uploaded.")
        return

    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    generation = _ensure_generation(client, bucket)

    # Upload only immutable objects that do not exist yet (content-suffixed keys).
    have = _existing_keys(client, bucket, f"{PACKS_PREFIX}/") | _existing_keys(client, bucket, f"{CATALOG_PREFIX}/")
    uploaded = 0
    for name, meta in pack_meta.items():
        if meta["key"] in have:
            continue
        _put_verified(client, bucket, meta["key"], pack_bytes[name], "application/octet-stream")
        uploaded += 1
        logger.info("  uploaded %s (%.1f KB)", meta["key"], meta["bytes"] / 1e3)
    for kind, meta in catalogs.items():
        if meta["key"] not in have:
            _put_verified(client, bucket, meta["key"], catalog_bytes[kind], "application/json")

    channel_manifest = {
        "v": 1,
        "version": version,
        "generation": generation,
        "channel": channel,
        "packs": pack_meta,
        "scopes": legacy_manifest["scopes"],
        "catalogs": catalogs,
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    body = json.dumps(channel_manifest, separators=(",", ":")).encode()

    # Content first, pointer last (MS2-FR-20): every referenced object is already
    # verified in the bucket before any pointer moves.
    if channel == "live":
        _promote_pointers(client, bucket, channel_manifest)
    else:
        _put_verified(client, bucket, f"{CHANNELS_PREFIX}/beta.json", body, "application/json")
        logger.info("Published to BETA (version %s) — live untouched; `promote` makes it live.", version)
    logger.info("Done: %d new object(s) uploaded; channel %s at version %s.", uploaded, channel, version)


def _promote_pointers(client, bucket: str, channel_manifest: dict[str, Any]) -> None:
    """Make a pointer set live: history-archive the current live set, then write
    channels/live.json AND the legacy client manifest (audio/manifest.json)."""
    current = _get_json(client, bucket, f"{CHANNELS_PREFIX}/live.json")
    if current and current.get("version") != channel_manifest["version"]:
        hist_key = f"{CHANNELS_PREFIX}/history/{current.get('publishedAt', 'unknown')}-{current['version']}.json"
        _put_verified(client, bucket, hist_key,
                      json.dumps(current, separators=(",", ":")).encode(), "application/json")
        logger.info("  archived previous live version %s → %s", current["version"], hist_key)

    live = dict(channel_manifest, channel="live")
    _put_verified(client, bucket, f"{CHANNELS_PREFIX}/live.json",
                  json.dumps(live, separators=(",", ":")).encode(), "application/json")
    legacy = {
        "version": live["version"],
        "packs": live["packs"],
        "scopes": live["scopes"],
    }
    _put_verified(client, bucket, LEGACY_MANIFEST_KEY,
                  json.dumps(legacy, separators=(",", ":")).encode(), "application/json")
    logger.info("LIVE now at version %s (legacy manifest updated).", live["version"])


def promote(env: envs.Environment) -> None:
    client = media_delivery.r2_client()
    beta = _get_json(client, env.r2_bucket, f"{CHANNELS_PREFIX}/beta.json")
    if not beta:
        raise PublishError("no beta channel manifest to promote")
    live = _get_json(client, env.r2_bucket, f"{CHANNELS_PREFIX}/live.json")
    if live and live.get("version") == beta.get("version"):
        logger.info("live already at beta's version %s — nothing to do", beta["version"])
        return
    _promote_pointers(client, env.r2_bucket, beta)


def rollback(env: envs.Environment) -> None:
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    history = sorted(_existing_keys(client, bucket, f"{CHANNELS_PREFIX}/history/"))
    if not history:
        raise PublishError("no history to roll back to")
    prev = _get_json(client, bucket, history[-1])
    if not prev:
        raise PublishError(f"could not read {history[-1]}")
    logger.info("rolling back live → version %s (%s)", prev["version"], history[-1])
    _promote_pointers(client, bucket, prev)


def status(env: envs.Environment) -> None:
    client = media_delivery.r2_client()
    for ch in CHANNELS:
        m = _get_json(client, env.r2_bucket, f"{CHANNELS_PREFIX}/{ch}.json")
        if m:
            print(f"{ch:5}: version {m['version']}  generation {m['generation']}  "
                  f"packs {len(m['packs'])}  publishedAt {m.get('publishedAt')}")
        else:
            print(f"{ch:5}: (none)")
    legacy = _get_json(client, env.r2_bucket, LEGACY_MANIFEST_KEY)
    print(f"legacy: version {legacy['version']}" if legacy else "legacy: (none)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish media (catalog + packs + channels) per environment.")
    parser.add_argument("command", choices=("publish", "promote", "rollback", "status"))
    parser.add_argument("--env", choices=envs.environment_names(), default=envs.DEFAULT_ENV)
    parser.add_argument("--channel", choices=CHANNELS)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-missing-media", action="store_true",
                        help="Continue when clips/masters are missing locally (they are left out).")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    env = envs.load_environment(args.env)
    # Channel default: prod publishes stage to BETA (promote makes them live);
    # dev/test publish straight to live (MS2-FR-20).
    channel = args.channel or ("beta" if env.is_prod else "live")

    try:
        if args.command == "publish":
            if env.is_prod and channel == "live":
                envs.confirm_production(env, action="publish media DIRECTLY TO LIVE (bypassing beta)")
            elif env.is_prod:
                envs.confirm_production(env, action="publish media to the beta channel")
            publish(env, channel, dry_run=args.dry_run, skip_missing=args.skip_missing_media)
        elif args.command == "promote":
            envs.confirm_production(env, action="PROMOTE beta media to live")
            promote(env)
        elif args.command == "rollback":
            envs.confirm_production(env, action="ROLL BACK live media")
            rollback(env)
        else:
            status(env)
    except (PublishError, envs.EnvironmentError_) as exc:
        logger.error("%s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
