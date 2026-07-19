"""
Shared media-delivery PRIMITIVES for the build pipeline.

This module is the generic, media-agnostic machinery: the `.pack` container format,
pack hashing + blob-integrity digest, the manifest builder (version + scope map), the
R2 client, the content-addressed master store, and orphan pruning. The generation tools
(audio_sync.py, image_sync.py) use the master-store + client helpers to mirror their
finished files; the PUBLISHER (media_publish.py) uses the pack/manifest builders.

Publishing is media_publish.py's job ALONE. The old `publish()`/`fetch_remote_manifest()`
here let each producer rewrite the shared audio/manifest.json in place — which clobbered
media_publish's output with name-keyed metas (audit 2026-07-19, H7). They were removed;
producers no longer touch R2 pack/manifest state.

R2 layout (the "audio/" root is historical — it is the media root for ALL kinds):
  audio/packs/<name>-<sha12>.pack      # immutable content-suffixed delivery bundles
  (audio/manifest.json was retired 2026-07-19 — channels/live.json is the one pointer)
  <files_prefix>/<content_hash>.<ext>  # content-addressed masters (audio/files/<h>.m4a, image/files/<h>.heic)

Credentials (sync/.env): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import struct
from pathlib import Path
from typing import Any

logger = logging.getLogger("media_delivery")

# The single media manifest + shared pack object prefix (historical "audio" name).
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
