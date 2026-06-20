"""
Audio sync pipeline: synthesize pronunciation MP3s for every vocabulary word,
pack them by type+level, and upload to Cloudflare R2.

Runs alongside the text sync (sync.py). Reuses sync.py's Excel reader so it sees
exactly the same validated rows (same ids = sha256(level|word)[:16]).

Design (mirrors the agreed concept):
  - One MP3 per word, named "<id>.mp3". Nouns spoken as "<article> <word>";
    other types as the bare word (see audio_engine.synthesis_for).
  - Idempotent: a local cache (audio_cache/) keyed by audio_hash means only
    new/changed words are re-synthesized. Text-only edits never re-synthesize.
  - Downloaded in PACKS, not per file: one ".pack" container per group so the
    app fetches a few dozen files instead of thousands.
      * "free"            -> every free=1 word (the 100-word preview)
      * "<type>s/<level>" -> the full dataset, grouped (e.g. "nouns/a1.1")
  - Pack container format (no zip dependency on the client):
      [4-byte big-endian header length][UTF-8 JSON header][concatenated mp3 bytes]
      header = {"v":1,"files":[{"id": "...", "len": <int>}, ...]}  (sorted by id)
  - manifest.json (R2 key audio/manifest.json) lists every pack's hash/bytes and
    which packs each scope may download. The read worker serves it, scope-filtered.

Environment (sync/.env):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

Usage:
  python audio_sync.py                # synth changed, build packs, upload changed
  python audio_sync.py --dry-run      # synth + build locally, upload nothing
  python audio_sync.py --no-synth     # rebuild/upload packs from existing cache
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import struct
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import audio_engine
import sync  # reuse read_excel / TABLE_CONFIG / logging setup from the text pipeline

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("audio_sync")

CACHE_DIR = Path(__file__).parent / "audio_cache"
INDEX_PATH = CACHE_DIR / "index.json"          # {id: audio_hash}
PACKS_PREFIX = "audio/packs"                    # R2 key prefix for packs
MANIFEST_KEY = "audio/manifest.json"           # R2 key for the manifest

MAX_WORKERS = 6
PACK_FORMAT_VERSION = 1


# ---------------------------------------------------------------------------
# Row collection
# ---------------------------------------------------------------------------

def _kind_of(table: str, row: dict[str, Any]) -> str:
    """Part of speech used for pack grouping: noun/verb/adjective/adverb."""
    if table == "nouns":
        return "noun"
    if table == "verbs":
        return "verb"
    # adverbs_adjectives carries the distinction in its Type column.
    t = (row.get("type") or "").strip().lower()
    return "adverb" if t == "adverb" else "adjective"


def collect_words() -> list[dict[str, Any]]:
    """Read every table and return a flat list of word descriptors.

    Each: {id, level, kind, free, text, voice, audio_hash}.
    """
    words: list[dict[str, Any]] = []
    for table in sync.TABLE_CONFIG:
        rows = sync.read_excel(table)
        logger.info("  %s: %d rows", table, len(rows))
        for row in rows:
            spec = audio_engine.synthesis_for(table, row)
            if spec is None:
                logger.warning("  skipping %s (no speakable word)", row.get("id"))
                continue
            text, voice = spec
            words.append({
                "id": row["id"],
                "level": (row.get("level") or "").strip().lower(),
                "kind": _kind_of(table, row),
                "free": int(row.get("free") or 0),
                "text": text,
                "voice": voice,
                "audio_hash": audio_engine.audio_hash(text, voice),
            })
    return words


# ---------------------------------------------------------------------------
# Synthesis cache (idempotent)
# ---------------------------------------------------------------------------

def _load_index() -> dict[str, str]:
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("  cache index unreadable — rebuilding from scratch")
    return {}


def _save_index(index: dict[str, str]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, sort_keys=True))


def _cache_path(word_id: str) -> Path:
    return CACHE_DIR / f"{word_id}.mp3"


def synthesize_changed(words: list[dict[str, Any]], dry_run: bool) -> dict[str, str]:
    """Synthesize any word whose cached audio_hash differs or whose MP3 is missing.

    Returns the updated index {id: audio_hash}.
    """
    index = _load_index()
    todo = [
        w for w in words
        if index.get(w["id"]) != w["audio_hash"] or not _cache_path(w["id"]).exists()
    ]
    logger.info("Synthesis: %d of %d words need (re)generation.", len(todo), len(words))

    if dry_run:
        logger.info("[DRY RUN] Skipping synthesis.")
        return index

    failed = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {
            ex.submit(audio_engine.synthesize, w["text"], w["voice"], _cache_path(w["id"])): w
            for w in todo
        }
        for i, fut in enumerate(as_completed(futures), start=1):
            w = futures[fut]
            try:
                fut.result()
                index[w["id"]] = w["audio_hash"]
                if i % 100 == 0:
                    logger.info("  …%d/%d synthesized", i, len(todo))
            except Exception as exc:  # noqa: BLE001 — log and continue, don't abort the batch
                failed += 1
                logger.warning("  failed %s (\"%s\"): %s", w["id"], w["text"], exc)

    # Prune cache entries for ids no longer present.
    current_ids = {w["id"] for w in words}
    for stale_id in list(index.keys()):
        if stale_id not in current_ids:
            index.pop(stale_id, None)
            _cache_path(stale_id).unlink(missing_ok=True)

    _save_index(index)
    if failed:
        logger.warning("Synthesis finished with %d failure(s).", failed)
    return index


# ---------------------------------------------------------------------------
# Pack building
# ---------------------------------------------------------------------------

def _group_words(words: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Build the pack -> members map.

    "free" gets every free word; "<type>s/<level>" gets the full grouping.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for w in words:
        full_pack = f"{w['kind']}s/{w['level']}"
        groups.setdefault(full_pack, []).append(w)
        if w["free"]:
            groups.setdefault("free", []).append(w)
    return groups


def _pack_hash(members: list[dict[str, Any]]) -> str:
    payload = "|".join(f"{m['id']}:{m['audio_hash']}" for m in sorted(members, key=lambda m: m["id"]))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _build_pack_bytes(members: list[dict[str, Any]]) -> bytes:
    """Serialize members into the custom .pack container."""
    ordered = sorted(members, key=lambda m: m["id"])
    blobs: list[bytes] = []
    files: list[dict[str, Any]] = []
    for m in ordered:
        data = _cache_path(m["id"]).read_bytes()
        files.append({"id": m["id"], "len": len(data)})
        blobs.append(data)
    header = json.dumps({"v": PACK_FORMAT_VERSION, "files": files}, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(header)) + header + b"".join(blobs)


# ---------------------------------------------------------------------------
# R2 (S3-compatible)
# ---------------------------------------------------------------------------

def _r2_client():
    import boto3  # local import so --dry-run works without credentials/boto3

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _fetch_remote_manifest(client, bucket: str) -> dict[str, Any]:
    try:
        obj = client.get_object(Bucket=bucket, Key=MANIFEST_KEY)
        return json.loads(obj["Body"].read())
    except Exception:  # noqa: BLE001 — missing/unreadable manifest -> treat as first run
        return {}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def build_and_upload(words: list[dict[str, Any]], dry_run: bool) -> None:
    groups = _group_words(words)
    logger.info("Packs: %d groups (incl. free).", len(groups))

    # Compute pack metadata for the new manifest.
    new_packs: dict[str, dict[str, Any]] = {}
    pack_bytes: dict[str, bytes] = {}
    for name, members in groups.items():
        data = _build_pack_bytes(members)
        pack_bytes[name] = data
        new_packs[name] = {
            "hash": _pack_hash(members),
            "bytes": len(data),
            "count": len(members),
        }

    # Scopes: free sessions get only the "free" pack; full sessions get everything
    # except the redundant free pack (the type/level packs already contain it).
    full_pack_names = sorted(n for n in new_packs if n != "free")
    manifest = {
        "version": hashlib.sha256(
            "|".join(f"{n}:{new_packs[n]['hash']}" for n in sorted(new_packs)).encode()
        ).hexdigest()[:16],
        "packs": new_packs,
        "scopes": {
            "free": ["free"] if "free" in new_packs else [],
            "full": full_pack_names,
        },
    }

    if dry_run:
        total = sum(p["bytes"] for p in new_packs.values())
        logger.info("[DRY RUN] Built %d packs (%.1f MB). Nothing uploaded.", len(new_packs), total / 1e6)
        logger.info("[DRY RUN] manifest version would be %s", manifest["version"])
        return

    bucket = os.environ["R2_BUCKET"]
    client = _r2_client()
    remote = _fetch_remote_manifest(client, bucket)
    remote_packs = remote.get("packs", {})

    uploaded = 0
    for name, meta in new_packs.items():
        if remote_packs.get(name, {}).get("hash") == meta["hash"]:
            continue  # unchanged — skip upload
        client.put_object(
            Bucket=bucket,
            Key=f"{PACKS_PREFIX}/{name}.pack",
            Body=pack_bytes[name],
            ContentType="application/octet-stream",
        )
        uploaded += 1
        logger.info("  uploaded %s (%d files, %.1f KB)", name, meta["count"], meta["bytes"] / 1e3)

    client.put_object(
        Bucket=bucket,
        Key=MANIFEST_KEY,
        Body=json.dumps(manifest).encode("utf-8"),
        ContentType="application/json",
    )
    logger.info("Uploaded %d changed pack(s) + manifest (version %s).", uploaded, manifest["version"])


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize and sync vocabulary audio to Cloudflare R2.")
    parser.add_argument("--dry-run", action="store_true", help="Synthesize + build locally, upload nothing.")
    parser.add_argument("--no-synth", action="store_true", help="Skip synthesis; pack from the existing cache.")
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument("-v", "--verbose", action="store_true")
    verbosity.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    sync._setup_logging(args.verbose, args.quiet)

    if not args.dry_run:
        missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
                   if not os.environ.get(k)]
        if missing:
            logger.error("Missing environment variables: %s", ", ".join(missing))
            logger.error("Set them in sync/.env (or run with --dry-run).")
            sys.exit(1)

    logger.info("Reading vocabulary…")
    try:
        words = collect_words()
    except sync.ValidationError as exc:
        logger.error("Validation failed: %s", exc)
        sys.exit(1)
    logger.info("Total speakable words: %d", len(words))

    if not args.no_synth:
        synthesize_changed(words, dry_run=args.dry_run)
    else:
        logger.info("Skipping synthesis (--no-synth).")

    build_and_upload(words, dry_run=args.dry_run)
    logger.info("Audio sync complete.")


if __name__ == "__main__":
    main()
