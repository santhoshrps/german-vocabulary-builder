"""
Shared media-delivery layer for the build pipeline.

There is ONE media manifest and ONE pack space in R2, served by the read-worker and
consumed by the iOS MediaSyncManager, spanning every media category (word audio,
plural, example-sentence audio, and images). Each producer — audio_sync.py and
image_sync.py — owns a DISJOINT set of pack names and calls `publish()` to update
ONLY its own packs while preserving the others, so the two pipelines share the one
manifest without ever clobbering each other.

This module is the generic, media-agnostic machinery both producers reuse: the
`.pack` container format, pack hashing + blob-integrity digest, the manifest
(version + scope map), the namespace-aware publish/merge, the R2 client, the
content-addressed master store, and orphan pruning. The category-specific parts
(what a "word" is, how it is produced/cached) stay in each producer.

R2 layout (the "audio/" root is historical — it is the media root for ALL kinds):
  audio/manifest.json                  # the single media manifest (all categories)
  audio/packs/<name>.pack              # delivery bundles: free, nouns/a1.1, sentence/a1.1, image/a1.1, image/free, …
  <files_prefix>/<content_hash>.<ext>  # per-producer content-addressed masters (audio/files/<h>.mp3, image/files/<h>.heic)

The `.pack` container + manifest schema match Others/Docs/audio.md and the iOS
`MediaStore.parse`, so adding a category needs no client change.

Credentials (sync/.env): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import struct
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("media_delivery")

# The single media manifest + shared pack object prefix (historical "audio" name).
MANIFEST_KEY = "audio/manifest.json"
PACKS_PREFIX = "audio/packs"
# `.pack` header version — must match the iOS MediaStore.parse expectation.
PACK_FORMAT_VERSION = 1

# A pack member is a tuple: (id, content_hash, data_bytes)
#   id            — the file id written on device (e.g. "<serverID>" or "<serverID>_plural")
#   content_hash  — content identity for diffing (audio_hash for audio; image content hash for images)
#   data_bytes    — the file's bytes to embed in the pack
Member = tuple[str, str, bytes]


# ---------------------------------------------------------------------------
# Pack container, hashing, integrity
# ---------------------------------------------------------------------------

def is_free_pack(name: str) -> bool:
    """A starter (free-tier) pack: the curated `free` pack, or any `<category>/free` pack
    (e.g. `plural/free`, `sentence/free`, `image/free`)."""
    return name == "free" or name.endswith("/free")


def pack_hash(members: list[Member]) -> str:
    """Content-identity of a pack: sha256 of sorted `id:content_hash` lines (16 hex).

    Changes whenever any member's content changes — this is the client's download trigger.
    It is NOT an integrity check of the bytes (see `sha` in `pack_meta`).
    """
    payload = "|".join(f"{m[0]}:{m[1]}" for m in sorted(members, key=lambda m: m[0]))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def build_pack_bytes(members: list[Member]) -> bytes:
    """Serialize members into the custom `.pack` container the iOS client parses with no zip dep:

        [4-byte big-endian header length][UTF-8 JSON header][concatenated file bytes]
        header = {"v": 1, "files": [{"id": "...", "len": 1234}, ...]}   # in id order

    Members are written in id order so the layout is deterministic (stable bytes → stable blob sha).
    """
    ordered = sorted(members, key=lambda m: m[0])
    blobs: list[bytes] = []
    files: list[dict[str, Any]] = []
    for mid, _ch, data in ordered:
        files.append({"id": mid, "len": len(data)})
        blobs.append(data)
    header = json.dumps({"v": PACK_FORMAT_VERSION, "files": files}, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(header)) + header + b"".join(blobs)


def pack_meta(members: list[Member], data: bytes) -> dict[str, Any]:
    """Manifest entry for one pack: content-identity `hash` (diff), blob `sha` (integrity over the
    ACTUAL bytes — covers every file at once), `bytes`, and `count`."""
    return {
        "hash": pack_hash(members),
        "sha": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "count": len(members),
    }


def build_manifest(packs: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The media manifest over the MERGED pack set: a scope-qualified version + the free/full scope map.

    `free`  = every starter (`*/free`) pack — downloaded by everyone, any network (MS-FR-FREE-3).
    `full`  = every pack — full sessions are entitled to all of it; the client chooses which heavy
              categories to actually fetch (the opt-in toggles).
    """
    free = sorted(n for n in packs if is_free_pack(n))
    full = sorted(packs.keys())
    version = hashlib.sha256(
        "|".join(f"{n}:{packs[n]['hash']}" for n in sorted(packs)).encode("utf-8")
    ).hexdigest()[:16]
    return {"version": version, "packs": packs, "scopes": {"free": free, "full": full}}


# ---------------------------------------------------------------------------
# R2 (S3-compatible)
# ---------------------------------------------------------------------------

def r2_client():
    """Build an R2 (S3-compatible) client from the environment. boto3 is imported lazily so
    `--dry-run` works without credentials/boto3 installed."""
    import boto3

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def fetch_remote_manifest(client, bucket: str) -> dict[str, Any]:
    """Read the current media manifest from R2; a missing/unreadable manifest is treated as a first
    run (empty), so the very first publish creates it."""
    try:
        obj = client.get_object(Bucket=bucket, Key=MANIFEST_KEY)
        return json.loads(obj["Body"].read())
    except Exception:  # noqa: BLE001 — missing/unreadable manifest -> first run
        return {}


def publish(
    *,
    owned_packs: dict[str, list[Member]],
    owns: Callable[[str], bool],
    client=None,
    bucket: str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Update THIS producer's packs in the one shared media manifest, namespace-aware.

    Reads the current manifest, keeps every FOREIGN pack (one this producer does not own) exactly as
    it is, replaces this producer's packs with freshly built ones, recomputes the merged version +
    scopes, uploads only changed owned packs + the merged manifest, and deletes R2 objects for owned
    packs that have disappeared. Because each producer touches only `owns(name)` packs, audio_sync and
    image_sync can share one manifest without clobbering each other.

    Args:
      owned_packs: {pack_name: [(id, content_hash, data_bytes), ...]} — the packs this producer owns
                   this run. Every name MUST satisfy `owns(name)`.
      owns:        predicate identifying this producer's namespace (e.g. for images:
                   `lambda n: n.startswith("image/")`; for audio: the inverse).
    Returns the merged manifest dict.
    """
    # Guard: a producer must only publish packs it owns, or the merge would drop/duplicate packs.
    stray = [n for n in owned_packs if not owns(n)]
    if stray:
        raise ValueError(f"publish() got packs outside this producer's namespace: {stray}")

    # 1. Build bytes + metadata for the owned packs.
    owned_meta: dict[str, dict[str, Any]] = {}
    owned_bytes: dict[str, bytes] = {}
    for name, members in owned_packs.items():
        data = build_pack_bytes(members)
        owned_bytes[name] = data
        owned_meta[name] = pack_meta(members, data)

    # 2. Merge: foreign packs from the remote manifest + our freshly-built owned packs.
    remote = fetch_remote_manifest(client, bucket) if client is not None else {}
    remote_packs: dict[str, dict[str, Any]] = remote.get("packs", {})
    merged: dict[str, dict[str, Any]] = {n: m for n, m in remote_packs.items() if not owns(n)}
    merged.update(owned_meta)
    manifest = build_manifest(merged)

    if dry_run:
        total = sum(m["bytes"] for m in owned_meta.values())
        logger.info(
            "[DRY RUN] %d owned pack(s) (%.1f MB); merged manifest version would be %s (%d packs total).",
            len(owned_meta), total / 1e6, manifest["version"], len(merged),
        )
        return manifest

    assert client is not None and bucket is not None, "client + bucket required when not dry_run"

    # 3. Upload only owned packs whose blob changed (compare `sha`), then prune obsolete owned packs.
    uploaded = 0
    for name, meta in owned_meta.items():
        if not force and remote_packs.get(name, {}).get("sha") == meta["sha"]:
            continue  # exact blob already in R2
        client.put_object(
            Bucket=bucket,
            Key=f"{PACKS_PREFIX}/{name}.pack",
            Body=owned_bytes[name],
            ContentType="application/octet-stream",
        )
        uploaded += 1
        logger.info("  uploaded %s (%d files, %.1f KB)", name, meta["count"], meta["bytes"] / 1e3)

    removed = [n for n in remote_packs if owns(n) and n not in owned_meta]
    for name in removed:
        client.delete_object(Bucket=bucket, Key=f"{PACKS_PREFIX}/{name}.pack")
    if removed:
        logger.info("  removed %d obsolete pack object(s): %s", len(removed), ", ".join(sorted(removed)))

    # 4. Write the merged manifest last (so it never references a pack we haven't uploaded).
    client.put_object(
        Bucket=bucket,
        Key=MANIFEST_KEY,
        Body=json.dumps(manifest).encode("utf-8"),
        ContentType="application/json",
    )
    logger.info(
        "Published %d changed pack(s) + merged manifest (version %s, %d packs total).",
        uploaded, manifest["version"], len(merged),
    )
    return manifest


# ---------------------------------------------------------------------------
# Content-addressed master store (per producer: own prefix + extension)
# ---------------------------------------------------------------------------
#
# The durable, deduplicated home of each finished media file, keyed by its content hash. NOT what the
# app downloads (that is the packs) — this is the build pipeline's safety net: on a cache miss the
# producer pulls the finished file back from R2 instead of re-producing it (re-synthesizing audio, or
# re-sourcing/re-reviewing an image). See Others/Docs/image_generation.md "Whats the purpose".

_CONTENT_TYPES = {"mp3": "audio/mpeg", "heic": "image/heic", "webp": "image/webp",
                  "png": "image/png", "jpg": "image/jpeg"}


def file_key(files_prefix: str, content_hash: str, ext: str) -> str:
    return f"{files_prefix}/{content_hash}.{ext}"


def download_file(client, bucket: str, files_prefix: str, content_hash: str, ext: str, dest: Path) -> bool:
    """Pull a content-addressed master from R2 to `dest`. Returns False if it is not there."""
    try:
        obj = client.get_object(Bucket=bucket, Key=file_key(files_prefix, content_hash, ext))
    except Exception:  # noqa: BLE001 — not in R2
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(obj["Body"].read())
    return True


def upload_file(client, bucket: str, files_prefix: str, content_hash: str, ext: str, src: Path) -> None:
    """Mirror a finished master file to R2, keyed by its content hash (idempotent — same hash = same key)."""
    client.put_object(
        Bucket=bucket,
        Key=file_key(files_prefix, content_hash, ext),
        Body=Path(src).read_bytes(),
        ContentType=_CONTENT_TYPES.get(ext, "application/octet-stream"),
    )


def prune_orphan_files(client, bucket: str, files_prefix: str, ext: str, live_hashes: set[str]) -> None:
    """Delete `<files_prefix>/<hash>.<ext>` masters no longer referenced by the current content set."""
    prefix = f"{files_prefix}/"
    suffix = f".{ext}"
    paginator = client.get_paginator("list_objects_v2")
    to_delete: list[dict[str, str]] = []
    scanned = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            scanned += 1
            key = obj["Key"]
            h = key[len(prefix):]
            if h.endswith(suffix):
                h = h[: -len(suffix)]
            if h not in live_hashes:
                to_delete.append({"Key": key})
    logger.info("Prune[%s]: %d master(s) in R2, %d orphan(s).", files_prefix, scanned, len(to_delete))
    for i in range(0, len(to_delete), 1000):  # S3 delete_objects caps at 1000 keys/call
        client.delete_objects(Bucket=bucket, Delete={"Objects": to_delete[i: i + 1000], "Quiet": True})
    if to_delete:
        logger.info("Prune[%s]: deleted %d orphan(s).", files_prefix, len(to_delete))
