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
# L10 / MS2-FR-23: minimum client generation for TODAY's media format. Raise only on a
# breaking media-format change (must match a bump the shipped app understands).
MEDIA_MIN_CLIENT_GENERATION = 1
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
        # H6: the catalog + pack identity is the CONTENT hash of the actual bytes, NOT the
        # synthesis-recipe hash (`audio_hash`). The recipe hash only decides "re-synthesize?"
        # (it can map to different bytes across a resynth); a content hash is what lets a
        # client diff correctly, what the per-file delivery path is addressed by, and what a
        # corrupt clip fails against. (Images were already content-hashed.)
        content_hash = hashlib.sha256(data).hexdigest()
        w2 = dict(w, id=new_id)
        full_pack, free_pack = audio_sync._packs_for(w2)
        member: media_delivery.Member = (new_id, content_hash, data)
        packs.setdefault(full_pack, []).append(member)
        if w["free"]:
            packs.setdefault(free_pack, []).append(member)
        entries.append({
            "id": new_id, "kind": w["variant"] if w["variant"] != "singular" else "word",
            "type": w["kind"], "level": w["level"], "free": int(w["free"]),
            "hash": content_hash, "bytes": len(data),
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
    unaliased = 0   # L19: approved images whose noun is gone from the sheet / has no v2 id
    packs: dict[str, list[media_delivery.Member]] = {}
    entries: list[dict[str, Any]] = []
    for legacy_id, rec in image_decisions.approved(store).items():
        noun = by_id.get(legacy_id)
        new_id = relabel(legacy_id, old_to_new)
        if noun is None or new_id is None:
            unaliased += 1
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
    if unaliased:
        # L19: mirror collect_audio's signal — an approved image dropping out silently would
        # otherwise leave the operator wondering why a picture vanished from the catalog.
        logger.warning("images: %d approved image(s) belong to nouns without a v2 identity "
                       "(removed from the sheet or unaliased) — left out", unaliased)
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
        # L10 / MS2-FR-23: the media compat floor. The client pauses media sync (cached media
        # keeps working) + shows "update the app" when its generation is below this. 1 = today's
        # format, every shipped app reads it; raise it only on a breaking media-format change.
        "minClient": MEDIA_MIN_CLIENT_GENERATION,
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
    bucket = env.r2_bucket
    beta = _get_json(client, bucket, f"{CHANNELS_PREFIX}/beta.json")
    if not beta:
        raise PublishError("no beta channel manifest to promote")
    live = _get_json(client, bucket, f"{CHANNELS_PREFIX}/live.json")
    legacy = _get_json(client, bucket, LEGACY_MANIFEST_KEY)
    # M23: "already done" requires BOTH the live channel AND the legacy client manifest to
    # match beta. A promote that crashed between the two writes left live == beta but the
    # legacy manifest stale, and the old early-return-on-live-only made a re-run a no-op that
    # could never repair it. `_promote_pointers` is idempotent (it re-writes both, and skips
    # the history archive when live is already at beta's version), so re-running now self-heals.
    if (live and live.get("version") == beta.get("version")
            and legacy and legacy.get("version") == beta.get("version")):
        logger.info("live + legacy already at beta's version %s — nothing to do", beta["version"])
        return
    _promote_pointers(client, bucket, beta)


def rollback(env: envs.Environment, to_version: str | None = None) -> None:
    """Restore a previous live pointer set from history. Default: a TRUE step back — the
    newest version published BEFORE the current live (so repeated rollbacks keep going back,
    never flip-flop). `--to <version>` restores a specific retained version unambiguously
    (M24). Objects are immutable, so any retained version's references are always intact."""
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    hist = [(k, _get_json(client, bucket, k))
            for k in sorted(_existing_keys(client, bucket, f"{CHANNELS_PREFIX}/history/"))]
    hist = [(k, m) for k, m in hist if m]   # readable only
    if not hist:
        raise PublishError("no history to roll back to")

    if to_version:
        matches = [(k, m) for k, m in hist if m.get("version") == to_version]
        if not matches:
            available = ", ".join(sorted({m["version"] for _, m in hist}))
            raise PublishError(f"no history entry for version {to_version} (have: {available})")
        target_key, target = matches[-1]
    else:
        # Default: the newest version strictly OLDER (by publishedAt) than current live — a
        # real step back. Comparing ISO-8601 UTC timestamps lexicographically is correct.
        live = _get_json(client, bucket, f"{CHANNELS_PREFIX}/live.json")
        live_pub = (live or {}).get("publishedAt") or ""
        older = [(k, m) for k, m in hist if (m.get("publishedAt") or "") < live_pub]
        if not older:
            available = ", ".join(sorted({m["version"] for _, m in hist}))
            raise PublishError(f"no earlier version to roll back to — use --to <version> (have: {available})")
        target_key, target = older[-1]

    logger.info("rolling back live → version %s (%s)", target["version"], target_key)
    _promote_pointers(client, bucket, target)


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
    live_entries: list[dict[str, Any]] = []   # live-channel catalog entries (deep cross-checks + masters)
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
                        live_entries.extend(entries)
                        catalog_ids.update(e["id"] for e in entries)

    if deep and live and catalog_ids:
        # M21: cross-check PER STORAGE KIND. A word's image entry shares its bare id with
        # its audio entry, so a pooled id set let a missing image member hide behind the
        # same word's audio-pack membership.
        def _storage_kind(catalog_kind: str) -> str:
            return "image" if catalog_kind == "image" else "audio"

        catalog_by_kind: dict[str, set[str]] = {"audio": set(), "image": set()}
        for e in live_entries:
            catalog_by_kind[_storage_kind(e["kind"])].add(e["id"])
        member_by_kind: dict[str, set[str]] = {"audio": set(), "image": set()}
        import struct as _struct
        for name, meta in live["packs"].items():
            data = client.get_object(Bucket=bucket, Key=meta["key"])["Body"].read()
            hlen = _struct.unpack(">I", data[:4])[0]
            pack_kind = "image" if name.startswith("image/") else "audio"
            for f in json.loads(data[4 : 4 + hlen])["files"]:
                member_by_kind[pack_kind].add(f["id"])
        for sk in ("audio", "image"):
            only_cat = catalog_by_kind[sk] - member_by_kind[sk]
            only_pack = member_by_kind[sk] - catalog_by_kind[sk]
            if only_cat:
                problems.append(f"[{sk}] {len(only_cat)} catalog entr(ies) not in any pack (first: {sorted(only_cat)[:3]})")
            if only_pack:
                problems.append(f"[{sk}] {len(only_pack)} pack member(s) not in any catalog (first: {sorted(only_pack)[:3]})")

    if live and live_entries:
        # M27: the per-file masters are the content-addressed delivery source — audit them.
        # Existence for EVERY entry via LIST (fast, no per-object round-trips); with --deep
        # byte-verify a deterministic sample of BOTH kinds against their content hash — audio
        # is now content-hashed too (H6), so its masters are byte-verifiable like images.
        master_keys = (_existing_keys(client, bucket, "audio/files/")
                       | _existing_keys(client, bucket, "image/files/"))
        missing_masters: list[str] = []
        sample_by_kind: dict[str, list[str]] = {"audio": [], "image": []}
        seen_hashes: set[tuple[str, str]] = set()
        for e in live_entries:
            sk = "image" if e["kind"] == "image" else "audio"
            if (sk, e["hash"]) in seen_hashes:
                continue
            seen_hashes.add((sk, e["hash"]))
            key = f"{sk}/files/{e['hash']}.{'heic' if sk == 'image' else 'm4a'}"
            checked += 1
            if key not in master_keys:
                missing_masters.append(key)
            else:
                sample_by_kind[sk].append(e["hash"])
        if missing_masters:
            problems.append(f"{len(missing_masters)} per-file master(s) missing (first: {missing_masters[:3]})")
        if deep:
            for sk, ext in (("audio", "m4a"), ("image", "heic")):
                hashes = sorted(sample_by_kind[sk])
                sample = hashes[:: max(1, len(hashes) // 50)][:50] if hashes else []
                for h in sample:
                    body = client.get_object(Bucket=bucket, Key=f"{sk}/files/{h}.{ext}")["Body"].read()
                    if hashlib.sha256(body).hexdigest() != h:
                        problems.append(f"{sk} master {h}: bytes do not match content hash")
                checked += len(sample)

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

    # M22: image gates — previously the docstring promised HEIC checks that did not exist,
    # so a truncated/corrupt master could ship with a hash its bytes no longer matched.
    # Every APPROVED image's cached master must exist, match its content hash exactly
    # (the strongest structural check possible), be a plausible HEIC (ISO-BMFF ftyp with a
    # HEIF brand), and sit inside sane size bounds (masters are produced at ≤500 KB).
    heif_brands = {b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis", b"hevc"}
    image_sizes: list[int] = []
    images_scanned = 0
    for rec in image_decisions.approved(image_decisions.load()).values():
        h = rec["content_hash"]
        path = image_config.CACHE_DIR / f"{h}.{image_config.FILE_EXT}"
        if not path.exists():
            continue   # missing masters are mirror-masters'/audit's finding, not a QA structural fail
        data = path.read_bytes()
        images_scanned += 1
        if hashlib.sha256(data).hexdigest() != h:
            problems.append(f"image {h[:12]}: bytes do not match content hash (corrupt cache)")
            continue
        if len(data) < 2_000:
            problems.append(f"image {h[:12]}: implausibly small ({len(data)} B)")
            continue
        if data[4:8] != b"ftyp" or data[8:12] not in heif_brands:
            problems.append(f"image {h[:12]}: not a HEIC container (brand {data[8:12]!r})")
            continue
        if len(data) > 700_000:
            problems.append(f"image {h[:12]}: {len(data) / 1e3:.0f} KB exceeds the 500 KB master budget")
            continue
        image_sizes.append(len(data))
    if image_sizes:
        image_sizes.sort()
        logger.info("image QA: %d master(s) scanned, median %.0f KB, p95 %.0f KB, max %.0f KB",
                    images_scanned, image_sizes[len(image_sizes) // 2] / 1e3,
                    image_sizes[int(len(image_sizes) * 0.95)] / 1e3, image_sizes[-1] / 1e3)

    for pr in problems[:20]:
        logger.warning("QA: %s", pr)
    if len(problems) > 20:
        logger.warning("QA: … and %d more", len(problems) - 20)
    if shutil.which("ffmpeg") is None:
        logger.warning("QA: ffmpeg not installed — loudness (EBU R128) measurement unavailable "
                       "(brew install ffmpeg to enable; tracked in deferred.md)")
    if problems:
        raise PublishError(f"QA found {len(problems)} problem file(s)")
    logger.info("QA passed: no structural problems (audio + image).")


def mirror_masters(env: envs.Environment, dry_run: bool) -> None:
    """Mirror the content-addressed masters into this environment's bucket
    (audio/files/<hash>.m4a + image/files/<hash>.heic) — the new world's safety
    net, required before the legacy bucket can be decommissioned. Upload-if-absent.

    M26 hardening: uploads are write-verified (upload-if-absent means a corrupt
    object would otherwise poison the content-addressed store PERMANENTLY); image
    bytes are verified against their content hash BEFORE upload (locally checkable);
    and masters that are referenced but missing locally are REPORTED — an incomplete
    safety net must never look complete."""
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    index = json.loads(audio_sync.INDEX_PATH.read_text()) if audio_sync.INDEX_PATH.exists() else {}
    # H6: the DELIVERY masters are content-addressed (audio/files/<sha256(bytes)>.m4a) — the
    # same identity the catalog/pack use and the per-file grant path serves. Key by the clip's
    # content hash, not the recipe hash. (The recipe-keyed generation safety net is a separate
    # store, audio/masters/, owned by audio_sync.)
    audio_by_hash: dict[str, Path] = {}
    audio_missing = 0
    for legacy_id in index:
        path = audio_sync._cache_path(legacy_id)
        if path.exists():
            content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            audio_by_hash.setdefault(content_hash, path)
        else:
            audio_missing += 1
    store = image_decisions.load()
    image_hashes = {
        rec["content_hash"] for rec in image_decisions.approved(store).values()
    }
    image_by_hash: dict[str, Path] = {}
    image_missing = 0
    for h in image_hashes:
        path = image_config.CACHE_DIR / f"{h}.{image_config.FILE_EXT}"
        if path.exists():
            image_by_hash[h] = path
        else:
            image_missing += 1
    if audio_missing or image_missing:
        logger.warning("mirror-masters: %d audio + %d image referenced master(s) MISSING locally — "
                       "the mirror will be incomplete (run audio_sync/image tooling to restore them).",
                       audio_missing, image_missing)
    have = _existing_keys(client, bucket, "audio/files/") | _existing_keys(client, bucket, "image/files/")
    todo: list[tuple[str, str, Path, str]] = []   # (key, expected_content_hash, path, content_type)
    for h, path in audio_by_hash.items():
        key = f"audio/files/{h}.m4a"
        if key not in have:
            todo.append((key, h, path, "audio/mp4"))
    for h, path in image_by_hash.items():
        key = f"image/files/{h}.heic"
        if key not in have:
            todo.append((key, h, path, "image/heic"))
    total = sum(p.stat().st_size for _, _, p, _ in todo)
    logger.info("mirror-masters: %d audio + %d image master(s) local; %d to upload (%.1f MB)",
                len(audio_by_hash), len(image_by_hash), len(todo), total / 1e6)
    if dry_run:
        return
    corrupt = 0
    for i, (key, expected_hash, path, ctype) in enumerate(todo, 1):
        data = path.read_bytes()
        # H6: both stores are content-addressed now — a cache file whose bytes don't match
        # the content hash the key claims must NEVER enter the immutable store (it would
        # serve corrupt bytes forever on the per-file path).
        if hashlib.sha256(data).hexdigest() != expected_hash:
            logger.error("mirror-masters: SKIPPING corrupt cache file for %s (bytes != content hash)", expected_hash[:12])
            corrupt += 1
            continue
        _put_verified(client, bucket, key, data, ctype)
        if i % 500 == 0:
            logger.info("  … %d/%d", i, len(todo))
    if corrupt:
        raise PublishError(f"mirror-masters: {corrupt} corrupt cache file(s) skipped — fix the local cache")
    logger.info("mirror-masters: done (%d uploaded, content + write-verified).", len(todo))


def _collect_referenced(client, bucket: str) -> set[str]:
    """Every object key any pointer still references: live + beta + every history manifest,
    PLUS the legacy client manifest (audio/manifest.json is a live serving pointer too — H8).
    gc must never delete an object any of these point at."""
    referenced: set[str] = set()

    def _add_refs(manifest: dict | None) -> None:
        if not manifest:
            return
        for meta in manifest.get("packs", {}).values():
            # Content-suffixed key (v2) OR the name-derived legacy path, whichever a manifest carries.
            key = meta.get("key")
            if not key and isinstance(meta, dict):
                continue
            referenced.add(key)
        referenced.update(meta["key"] for meta in manifest.get("catalogs", {}).values() if meta.get("key"))

    for ch in CHANNELS:
        _add_refs(_get_json(client, bucket, f"{CHANNELS_PREFIX}/{ch}.json"))
    for hist_key in _existing_keys(client, bucket, f"{CHANNELS_PREFIX}/history/"):
        _add_refs(_get_json(client, bucket, hist_key))
    legacy = _get_json(client, bucket, LEGACY_MANIFEST_KEY)
    if legacy:
        for name, meta in legacy.get("packs", {}).items():
            referenced.add(meta.get("key") or f"{PACKS_PREFIX}/{name}.pack")
    return referenced


def gc(env: envs.Environment, grace_days: int, apply: bool) -> None:
    """Grace-windowed GC (MS2-FR-20): delete immutable pack/catalog objects that
    NO channel (live, beta, or any history entry) references and that are older
    than the grace window. Dry-run by default; --apply deletes."""
    import datetime as dt
    client = media_delivery.r2_client()
    bucket = env.r2_bucket
    referenced = _collect_referenced(client, bucket)

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=grace_days)
    victims: list[str] = []
    for prefix in (f"{PACKS_PREFIX}/", f"{CATALOG_PREFIX}/"):
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["Key"] in referenced:
                    continue
                if obj["LastModified"] < cutoff:
                    victims.append(obj["Key"])

    # M25: a publish that re-referenced an object could have landed AFTER the first
    # manifest read but before/while listing — deleting it would break the live world.
    # Re-read the pointers now and drop any candidate that became referenced since.
    if victims:
        referenced_after = _collect_referenced(client, bucket)
        newly_protected = [k for k in victims if k in referenced_after]
        if newly_protected:
            logger.info("gc: %d candidate(s) became referenced during the scan — keeping them.",
                        len(newly_protected))
        victims = [k for k in victims if k not in referenced_after]

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
    # Retained history, oldest→newest, so `rollback --to <version>` has a menu.
    hist = [_get_json(client, env.r2_bucket, k)
            for k in sorted(_existing_keys(client, env.r2_bucket, f"{CHANNELS_PREFIX}/history/"))]
    hist = [m for m in hist if m]
    if hist:
        print("history (rollback --to <version>):")
        for m in hist:
            print(f"  {m.get('publishedAt', '?'):20}  version {m['version']}")


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
    parser.add_argument("--to", metavar="VERSION",
                        help="rollback: restore a specific retained version (see `status`); "
                             "default rolls back one step to the previous live version.")
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
            envs.confirm_production(env,
                action=f"ROLL BACK live media{f' to {args.to}' if args.to else ' one step'}")
            rollback(env, to_version=args.to)
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
