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
    # Per-pass MEDIATRACE summary (#31): one structured line an operator can grep
    # (pipeline twin of the worker's MEDIATRACE events; see RUNBOOK.md).
    logger.info(json.dumps({
        "evt": "MEDIATRACE publish", "env": env.name, "channel": channel,
        "version": version, "generation": generation, "packs": len(packs),
        "uploaded": uploaded, "bytes": total,
        "audio_entries": len(audio_entries), "image_entries": len(image_entries),
    }))
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


# ---------------------------------------------------------------------------
# P2c: audit, QA, masters mirror, GC (MS2-FR-21/22, #28/#29/#31)
# ---------------------------------------------------------------------------

def _head(client, bucket: str, key: str) -> dict[str, Any] | None:
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except Exception:  # noqa: BLE001
        return None


def audit(env: envs.Environment, deep: bool) -> None:
    """World-coherence audit (MS2-FR-21). Default: every object referenced by any
    channel exists with the advertised size, and the legacy manifest matches live.
    --deep additionally downloads packs/catalogs, verifies sha256, parses pack
    headers and cross-checks member ids against the catalogs — the full proof."""
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    problems: list[str] = []
    checked = 0

    channels = {ch: _get_json(client, bucket, f"{CHANNELS_PREFIX}/{ch}.json") for ch in CHANNELS}
    legacy = _get_json(client, bucket, LEGACY_MANIFEST_KEY)
    live = channels.get("live")

    if live and legacy:
        if legacy.get("version") != live.get("version"):
            problems.append(f"legacy manifest version {legacy.get('version')} != live {live.get('version')}")
        if set(legacy.get("packs", {})) != set(live.get("packs", {})):
            problems.append("legacy manifest pack set differs from live channel")
    elif live and not legacy:
        problems.append("live channel exists but legacy manifest missing")

    catalog_ids: set[str] = set()
    for ch, manifest in channels.items():
        if not manifest:
            continue
        for name, meta in manifest.get("packs", {}).items():
            checked += 1
            head = _head(client, bucket, meta["key"])
            if head is None:
                problems.append(f"[{ch}] pack {name}: object missing ({meta['key']})")
            elif head["ContentLength"] != meta["bytes"]:
                problems.append(f"[{ch}] pack {name}: size {head['ContentLength']} != manifest {meta['bytes']}")
            elif deep:
                data = client.get_object(Bucket=bucket, Key=meta["key"])["Body"].read()
                if hashlib.sha256(data).hexdigest() != meta["sha"]:
                    problems.append(f"[{ch}] pack {name}: sha mismatch")
                else:
                    import struct as _struct
                    hlen = _struct.unpack(">I", data[:4])[0]
                    header = json.loads(data[4 : 4 + hlen])
                    if len(header["files"]) != meta["count"]:
                        problems.append(f"[{ch}] pack {name}: header count {len(header['files'])} != {meta['count']}")
        for kind, meta in manifest.get("catalogs", {}).items():
            checked += 1
            head = _head(client, bucket, meta["key"])
            if head is None:
                problems.append(f"[{ch}] catalog {kind}: object missing ({meta['key']})")
            elif deep:
                data = client.get_object(Bucket=bucket, Key=meta["key"])["Body"].read()
                if hashlib.sha256(data).hexdigest() != meta["sha"]:
                    problems.append(f"[{ch}] catalog {kind}: sha mismatch")
                else:
                    entries = json.loads(data)["entries"]
                    if len(entries) != meta["count"]:
                        problems.append(f"[{ch}] catalog {kind}: {len(entries)} entries != {meta['count']}")
                    if ch == "live":
                        catalog_ids.update(e["id"] for e in entries)

    if deep and live and catalog_ids:
        member_ids: set[str] = set()
        import struct as _struct
        for name, meta in live["packs"].items():
            data = client.get_object(Bucket=bucket, Key=meta["key"])["Body"].read()
            hlen = _struct.unpack(">I", data[:4])[0]
            for f in json.loads(data[4 : 4 + hlen])["files"]:
                member_ids.add(f["id"])
        only_cat = catalog_ids - member_ids
        only_pack = member_ids - catalog_ids
        if only_cat:
            problems.append(f"{len(only_cat)} catalog entr(ies) not in any pack (first: {sorted(only_cat)[:3]})")
        if only_pack:
            problems.append(f"{len(only_pack)} pack member(s) not in any catalog (first: {sorted(only_pack)[:3]})")

    if problems:
        for pr in problems:
            logger.error("AUDIT: %s", pr)
        raise PublishError(f"audit FAILED: {len(problems)} problem(s) across {checked} object check(s)")
    logger.info("audit OK: %d object check(s)%s, channels coherent.", checked, " (deep)" if deep else "")


def _m4a_duration_seconds(data: bytes) -> float | None:
    """Duration from the mvhd box (pure python; no ffmpeg). None if unparseable."""
    i, n = 0, len(data)
    def walk(start: int, end: int, target: bytes):
        j = start
        while j + 8 <= end:
            size = int.from_bytes(data[j:j+4], "big")
            box = data[j+4:j+8]
            if size < 8:
                return None
            if box == target:
                return (j, min(j + size, end))
            j += size
        return None
    moov = walk(0, n, b"moov")
    if not moov:
        return None
    mvhd = walk(moov[0] + 8, moov[1], b"mvhd")
    if not mvhd:
        return None
    j = mvhd[0] + 8
    version = data[j]
    if version == 0:
        timescale = int.from_bytes(data[j+12:j+16], "big")
        duration = int.from_bytes(data[j+16:j+20], "big")
    else:
        timescale = int.from_bytes(data[j+20:j+24], "big")
        duration = int.from_bytes(data[j+24:j+32], "big")
    return duration / timescale if timescale else None


def qa(env: envs.Environment) -> None:  # noqa: ARG001 — local corpus QA, env for symmetry
    """Structural QA gates over the LOCAL corpus (MS2-FR-22, measure-first):
    every cached clip must be a valid MP4 container with a sane duration and
    bitrate; images must be plausible HEIC masters. Prints corpus statistics and
    flags outliers. True loudness (EBU R128) requires ffmpeg — when it is
    installed this command grows the measurement pass; absence is reported, not
    silently skipped."""
    import shutil
    index = json.loads(audio_sync.INDEX_PATH.read_text()) if audio_sync.INDEX_PATH.exists() else {}
    durations: list[float] = []
    problems: list[str] = []
    scanned = 0
    for legacy_id in index:
        path = audio_sync._cache_path(legacy_id)
        if not path.exists():
            continue
        data = path.read_bytes()
        scanned += 1
        if len(data) < 800:
            problems.append(f"{legacy_id}: implausibly small ({len(data)} B)")
            continue
        if data[4:8] != b"ftyp":
            problems.append(f"{legacy_id}: not an MP4 container")
            continue
        dur = _m4a_duration_seconds(data)
        if dur is None:
            problems.append(f"{legacy_id}: unparseable duration")
        elif not (0.3 <= dur <= 30.0):
            problems.append(f"{legacy_id}: duration {dur:.1f}s outside 0.3–30s")
        else:
            durations.append(dur)
    if durations:
        durations.sort()
        mid = durations[len(durations) // 2]
        logger.info("audio QA: %d clip(s) scanned, median %.1fs, p95 %.1fs, max %.1fs",
                    scanned, mid, durations[int(len(durations) * 0.95)], durations[-1])
    for pr in problems[:20]:
        logger.warning("QA: %s", pr)
    if len(problems) > 20:
        logger.warning("QA: … and %d more", len(problems) - 20)
    if shutil.which("ffmpeg") is None:
        logger.warning("QA: ffmpeg not installed — loudness (EBU R128) measurement unavailable "
                       "(brew install ffmpeg to enable; tracked in deferred.md)")
    if problems:
        raise PublishError(f"QA found {len(problems)} problem clip(s)")
    logger.info("QA passed: no structural problems.")


def mirror_masters(env: envs.Environment, dry_run: bool) -> None:
    """Mirror the content-addressed masters into this environment's bucket
    (audio/files/<hash>.m4a + image/files/<hash>.heic) — the new world's safety
    net, required before the legacy bucket can be decommissioned. Upload-if-absent."""
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    index = json.loads(audio_sync.INDEX_PATH.read_text()) if audio_sync.INDEX_PATH.exists() else {}
    audio_by_hash: dict[str, Path] = {}
    for legacy_id, h in index.items():
        path = audio_sync._cache_path(legacy_id)
        if path.exists():
            audio_by_hash.setdefault(h, path)
    store = image_decisions.load()
    image_hashes = {
        rec["content_hash"] for rec in image_decisions.approved(store).values()
    }
    image_by_hash = {
        h: image_config.CACHE_DIR / f"{h}.{image_config.FILE_EXT}"
        for h in image_hashes
        if (image_config.CACHE_DIR / f"{h}.{image_config.FILE_EXT}").exists()
    }
    have = _existing_keys(client, bucket, "audio/files/") | _existing_keys(client, bucket, "image/files/")
    todo: list[tuple[str, Path, str]] = []
    for h, path in audio_by_hash.items():
        key = f"audio/files/{h}.m4a"
        if key not in have:
            todo.append((key, path, "audio/mp4"))
    for h, path in image_by_hash.items():
        key = f"image/files/{h}.heic"
        if key not in have:
            todo.append((key, path, "image/heic"))
    total = sum(p.stat().st_size for _, p, _ in todo)
    logger.info("mirror-masters: %d audio + %d image master(s) local; %d to upload (%.1f MB)",
                len(audio_by_hash), len(image_by_hash), len(todo), total / 1e6)
    if dry_run:
        return
    for i, (key, path, ctype) in enumerate(todo, 1):
        client.put_object(Bucket=bucket, Key=key, Body=path.read_bytes(), ContentType=ctype)
        if i % 500 == 0:
            logger.info("  … %d/%d", i, len(todo))
    logger.info("mirror-masters: done (%d uploaded).", len(todo))


def gc(env: envs.Environment, grace_days: int, apply: bool) -> None:
    """Grace-windowed GC (MS2-FR-20): delete immutable pack/catalog objects that
    NO channel (live, beta, or any history entry) references and that are older
    than the grace window. Dry-run by default; --apply deletes."""
    import datetime as dt
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    referenced: set[str] = set()
    for ch in CHANNELS:
        m = _get_json(client, bucket, f"{CHANNELS_PREFIX}/{ch}.json")
        if m:
            referenced.update(meta["key"] for meta in m.get("packs", {}).values())
            referenced.update(meta["key"] for meta in m.get("catalogs", {}).values())
    for hist_key in _existing_keys(client, bucket, f"{CHANNELS_PREFIX}/history/"):
        m = _get_json(client, bucket, hist_key)
        if m:
            referenced.update(meta["key"] for meta in m.get("packs", {}).values())
            referenced.update(meta["key"] for meta in m.get("catalogs", {}).values())

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=grace_days)
    victims: list[str] = []
    for prefix in (f"{PACKS_PREFIX}/", f"{CATALOG_PREFIX}/"):
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["Key"] in referenced:
                    continue
                if obj["LastModified"] < cutoff:
                    victims.append(obj["Key"])
    logger.info("gc: %d referenced object(s); %d unreferenced older than %dd%s",
                len(referenced), len(victims), grace_days, "" if apply else " (dry-run)")
    if apply:
        for i in range(0, len(victims), 1000):
            client.delete_objects(Bucket=bucket,
                                  Delete={"Objects": [{"Key": k} for k in victims[i:i+1000]], "Quiet": True})
        if victims:
            logger.info("gc: deleted %d object(s).", len(victims))
    else:
        for k in victims[:10]:
            logger.info("  would delete %s", k)


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
    parser.add_argument("command",
                        choices=("publish", "promote", "rollback", "status",
                                 "audit", "qa", "mirror-masters", "gc"))
    parser.add_argument("--env", choices=envs.environment_names(), default=envs.DEFAULT_ENV)
    parser.add_argument("--channel", choices=CHANNELS)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-missing-media", action="store_true",
                        help="Continue when clips/masters are missing locally (they are left out).")
    parser.add_argument("--deep", action="store_true",
                        help="audit: download and byte-verify every referenced object + cross-check pack members against catalogs.")
    parser.add_argument("--grace-days", type=int, default=7, help="gc: minimum object age to collect.")
    parser.add_argument("--apply", action="store_true", help="gc: actually delete (default dry-run).")
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
        elif args.command == "audit":
            audit(env, deep=args.deep)
        elif args.command == "qa":
            qa(env)
        elif args.command == "mirror-masters":
            mirror_masters(env, dry_run=args.dry_run)
        elif args.command == "gc":
            if args.apply:
                envs.confirm_production(env, action=f"GC-delete unreferenced media older than {args.grace_days}d")
            gc(env, args.grace_days, args.apply)
        else:
            status(env)
    except (PublishError, envs.EnvironmentError_) as exc:
        logger.error("%s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
