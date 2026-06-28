"""
Audio sync pipeline: synthesize pronunciation MP3s for every vocabulary word,
pack them by type+level, and upload to Cloudflare R2.

Runs alongside the text sync (sync.py). Reuses sync.py's Excel reader so it sees
exactly the same validated rows (same ids = sha256(level|word)[:16]).

Design (mirrors the agreed concept):
  - One MP3 per word, named "<id>.mp3". Nouns spoken as "<article> <word>";
    other types as the bare word (see audio_engine.synthesis_for).
  - Idempotent & durable: a local cache (audio_cache/) keyed by audio_hash means
    only new/changed words are re-synthesized, and every synthesized MP3 is also
    mirrored to R2 (audio/files/<audio_hash>.mp3). On a cache miss the canonical
    bytes are pulled from R2 rather than re-synthesized, so the audio for a given
    recipe is byte-stable forever — even on a fresh machine or after the local
    cache is cleared. (edge-tts is non-deterministic, so regeneration would
    otherwise yield different bytes and needlessly churn every pack.)
  - Downloaded in PACKS, not per file: one ".pack" container per group so the
    app fetches a few dozen files instead of thousands.
      * "free"              -> every free=1 word (the 100-word preview), singular
      * "<type>s/<level>"   -> the full dataset, grouped (e.g. "nouns/a1.1"), singular
      * "plural/<level>"    -> noun plural pronunciations ("die <plural>"), full set
      * "sentence/<level>"  -> example-sentence pronunciations (all word types), full set
      * "<variant>/free"    -> the free-word subset of each variant tier (plural/free, sentence/free)
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
  python audio_sync.py --prune-files  # also delete orphaned per-word MP3s from R2
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import audio_engine
import media_delivery  # shared .pack/manifest/R2 layer (also used by image_sync.py)
import sync  # reuse read_excel / TABLE_CONFIG / logging setup from the text pipeline

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("audio_sync")

CACHE_DIR = Path(__file__).parent / "audio_cache"
INDEX_PATH = CACHE_DIR / "index.json"          # {id: audio_hash}
FILES_PREFIX = "audio/files"                    # R2 key prefix for this producer's content-addressed MP3 masters
# The shared pack space + manifest + .pack format live in media_delivery.

MAX_WORKERS = 6


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


def _descriptor(word_id: str, level: str, kind: str, free: int,
                text: str, voice: str, variant: str) -> dict[str, Any]:
    """Build one audio descriptor — used identically for the singular and every extra variant."""
    return {
        "id": word_id,
        "level": level,
        "kind": kind,
        "free": free,
        "text": text,
        "voice": voice,
        "audio_hash": audio_engine.audio_hash(text, voice),
        "variant": variant,
    }


def collect_words() -> list[dict[str, Any]]:
    """Read every table and return a flat list of audio descriptors.

    Every word emits a "singular" descriptor. Nouns with a plural also emit "<id>_plural"
    (variant="plural"); any word with a German example sentence also emits "<id>_sentence"
    (variant="sentence"). Each: {id, level, kind, free, text, voice, audio_hash, variant}.
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
            wid = row["id"]
            level = (row.get("level") or "").strip().lower()
            kind = _kind_of(table, row)
            free = int(row.get("free") or 0)
            words.append(_descriptor(wid, level, kind, free, *spec, "singular"))

            # Extra spoken forms — each a variant id "<id>_<variant>" so it synthesizes, caches,
            # packs and re-syncs independently of the singular and of each other.
            if table == "nouns":
                pspec = audio_engine.plural_synthesis_for(row)
                if pspec is not None:
                    words.append(_descriptor(f"{wid}_plural", level, kind, free, *pspec, "plural"))
            sspec = audio_engine.sentence_synthesis_for(row)
            if sspec is not None:
                words.append(_descriptor(f"{wid}_sentence", level, kind, free, *sspec, "sentence"))
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


def _download_file(client, bucket: str, audio_hash: str, dest: Path) -> bool:
    """Pull a previously-synthesized MP3 master from R2 into the local cache. Returns True on
    success. This is what makes re-synthesis idempotent: the canonical bytes for a recipe live in R2
    (content-addressed by audio_hash) and are reused verbatim, never regenerated."""
    if client is None:
        return False
    return media_delivery.download_file(client, bucket, FILES_PREFIX, audio_hash, "mp3", dest)


def _upload_file(client, bucket: str, audio_hash: str, src: Path) -> None:
    """Mirror a freshly-synthesized MP3 master to R2 so it never needs regenerating."""
    if client is None:
        return
    media_delivery.upload_file(client, bucket, FILES_PREFIX, audio_hash, "mp3", src)


def _ensure_one(client, bucket: str | None, w: dict[str, Any], resynth: bool = False) -> str:
    """Produce the CURRENT MP3 for one word into the local cache. Returns "r2" | "tts".

    The caller only passes words whose audio_hash changed or whose MP3 is missing,
    so any existing local file (keyed by id, not audio_hash) is stale and must NOT
    be reused. Order: durable R2 copy (content-addressed by audio_hash) → TTS.
    With resynth=True, skip R2 and always synthesize fresh (then re-upload).
    """
    dest = _cache_path(w["id"])
    if not resynth and _download_file(client, bucket or "", w["audio_hash"], dest):
        return "r2"
    audio_engine.synthesize(w["text"], w["voice"], dest)
    _upload_file(client, bucket or "", w["audio_hash"], dest)
    return "tts"


def ensure_audio(
    words: list[dict[str, Any]], dry_run: bool, client, bucket: str | None, resynth: bool = False
) -> dict[str, str]:
    """Ensure every word has its current MP3 in the local cache.

    A word is (re)processed when its cached audio_hash differs or its MP3 is
    missing. For each: pull the durable R2 copy, else synthesize via TTS. With
    resynth=True, always synthesize fresh (ignore both the local cache and R2).
    Returns the updated index {id: audio_hash}.
    """
    index = _load_index()
    todo = words if resynth else [
        w for w in words
        if index.get(w["id"]) != w["audio_hash"] or not _cache_path(w["id"]).exists()
    ]
    verb = "re-synthesize (forced)" if resynth else "need (re)generation"
    logger.info("Audio: %d of %d words %s.", len(todo), len(words), verb)

    if dry_run:
        logger.info("[DRY RUN] Skipping synthesis.")
        return index

    failed = 0
    stats = {"r2": 0, "tts": 0}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(_ensure_one, client, bucket, w, resynth): w for w in todo}
        for i, fut in enumerate(as_completed(futures), start=1):
            w = futures[fut]
            try:
                stats[fut.result()] += 1
                index[w["id"]] = w["audio_hash"]
                if i % 100 == 0:
                    logger.info("  …%d/%d (r2=%d tts=%d)", i, len(todo), stats["r2"], stats["tts"])
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
    logger.info("Audio ready: %d reused from R2, %d synthesized.", stats["r2"], stats["tts"])
    if failed:
        logger.warning("Audio finished with %d failure(s).", failed)
    return index


# ---------------------------------------------------------------------------
# Pack grouping (the .pack container, hashing and manifest live in media_delivery)
# ---------------------------------------------------------------------------

def _owns_audio_pack(name: str) -> bool:
    """This producer owns EVERY pack except the image category (image/<level>, image/free),
    which image_sync.py owns. Used by media_delivery.publish so the two producers share the one
    manifest without clobbering each other."""
    return not name.startswith("image/")


def _packs_for(w: dict[str, Any]) -> tuple[str, str]:
    """(full_pack, free_pack) for a descriptor. The singular goes in the type/level tier; every
    other variant (plural, sentence, …) goes in its OWN parallel tier "<variant>/<level>" plus
    "<variant>/free" — so it downloads alongside the singular yet adding or changing one variant
    never re-uploads or re-downloads the others. One rule covers every current and future variant.
    """
    variant = w.get("variant", "singular")
    if variant == "singular":
        return f"{w['kind']}s/{w['level']}", "free"
    return f"{variant}/{w['level']}", f"{variant}/free"


def _group_words(words: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Build the pack -> members map (see _packs_for for the tiering)."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for w in words:
        full_pack, free_pack = _packs_for(w)
        groups.setdefault(full_pack, []).append(w)
        if w["free"]:
            groups.setdefault(free_pack, []).append(w)
    return groups


# ---------------------------------------------------------------------------
# R2 master mirror (the shared client/pack/manifest live in media_delivery)
# ---------------------------------------------------------------------------

def prune_orphan_files(client, bucket: str, live_hashes: set[str]) -> None:
    """Delete audio/files/<hash>.mp3 masters no longer referenced by the current vocabulary
    (e.g. after a voice/recipe change orphans the previous MP3s)."""
    media_delivery.prune_orphan_files(client, bucket, FILES_PREFIX, "mp3", live_hashes)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _hydrate_missing(words: list[dict[str, Any]], client, bucket: str | None) -> None:
    """Ensure every member MP3 exists locally before packing, pulling any missing
    ones from R2. Guarantees packs are built from the canonical bytes even if the
    local cache was partially lost (e.g. on a fresh machine, esp. with --no-synth)."""
    missing = [w for w in words if not _cache_path(w["id"]).exists()]
    if not missing:
        return
    if client is None:
        raise FileNotFoundError(
            f"{len(missing)} cached MP3(s) missing and R2 not configured — "
            f"run synthesis first or provide R2 credentials."
        )
    logger.info("Hydrating %d missing MP3(s) from R2…", len(missing))
    pulled = 0
    for w in missing:
        if _download_file(client, bucket or "", w["audio_hash"], _cache_path(w["id"])):
            pulled += 1
        else:
            logger.warning("  no R2 copy for %s (\"%s\") — synthesize first", w["id"], w.get("text"))
    logger.info("Hydrated %d/%d from R2.", pulled, len(missing))


def _build_owned_packs(groups: dict[str, list[dict[str, Any]]]) -> dict[str, list[media_delivery.Member]]:
    """Turn the grouped descriptors into media_delivery members (id, audio_hash, mp3 bytes).

    A member whose MP3 is missing (synthesis failed and no R2 copy) is skipped with a warning rather
    than aborting the run — the word simply has no audio in this pack until a later run produces it.
    """
    owned: dict[str, list[media_delivery.Member]] = {}
    for name, members in groups.items():
        out: list[media_delivery.Member] = []
        for m in sorted(members, key=lambda m: m["id"]):
            path = _cache_path(m["id"])
            if not path.exists():
                logger.warning("  pack: skipping %s — MP3 missing (synthesis failed?)", m["id"])
                continue
            out.append((m["id"], m["audio_hash"], path.read_bytes()))
        owned[name] = out
    return owned


def build_and_upload(
    words: list[dict[str, Any]], dry_run: bool, client=None, bucket: str | None = None, force: bool = False
) -> None:
    groups = _group_words(words)
    logger.info("Packs: %d groups (incl. free).", len(groups))

    if dry_run:
        # Cache may be incomplete (synthesis was skipped) and there's no R2 client to hydrate from —
        # report structure and let publish() preview without uploading.
        missing = [w for w in words if not _cache_path(w["id"]).exists()]
        if missing:
            logger.info(
                "[DRY RUN] %d packs across %d member files; %d not yet synthesized "
                "(run without --dry-run to generate them).",
                len(groups), len(words), len(missing),
            )
    else:
        # Make sure every member's bytes are present locally (pull from R2 if needed).
        _hydrate_missing(words, client, bucket)

    # Publish this producer's packs into the ONE shared media manifest, preserving the image
    # category (owned by image_sync.py). Scopes (free = starter packs, full = everything) and the
    # .pack container/hash/integrity are handled by media_delivery — see Others/Docs/audio.md.
    media_delivery.publish(
        owned_packs=_build_owned_packs(groups),
        owns=_owns_audio_pack,
        client=client,
        bucket=bucket,
        force=force,
        dry_run=dry_run,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize and sync vocabulary audio to Cloudflare R2.")
    parser.add_argument("--dry-run", action="store_true", help="Synthesize + build locally, upload nothing.")
    parser.add_argument("--no-synth", action="store_true", help="Skip synthesis; pack from the existing cache.")
    parser.add_argument("--resynth", action="store_true",
                        help="Force fresh TTS for every word, ignoring the local cache AND R2 (then re-upload).")
    parser.add_argument("--force", action="store_true", help="Re-upload every pack even if unchanged (recovery).")
    parser.add_argument("--prune-files", action="store_true",
                        help="After uploading, delete audio/files/ MP3s in R2 no longer referenced (orphans).")
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument("-v", "--verbose", action="store_true")
    verbosity.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    sync._setup_logging(args.verbose, args.quiet)

    if not args.dry_run:
        required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
        missing = [k for k in required if not os.environ.get(k)]
        # Synthesis (any run that may call TTS) needs Azure Speech credentials too.
        if not args.no_synth:
            if not os.environ.get("AZURE_SPEECH_KEY"):
                missing.append("AZURE_SPEECH_KEY")
            if not os.environ.get("AZURE_SPEECH_ENDPOINT") and not os.environ.get("AZURE_SPEECH_REGION"):
                missing.append("AZURE_SPEECH_ENDPOINT|AZURE_SPEECH_REGION")
        if missing:
            logger.error("Missing environment variables: %s", ", ".join(missing))
            logger.error("Set them in sync/.env (or run with --dry-run).")
            sys.exit(1)

    # One R2 client, shared by the durable MP3 mirror and the pack upload.
    client = None
    bucket = os.environ.get("R2_BUCKET")
    if not args.dry_run:
        client = media_delivery.r2_client()

    logger.info("Reading vocabulary…")
    try:
        words = collect_words()
    except sync.ValidationError as exc:
        logger.error("Validation failed: %s", exc)
        sys.exit(1)
    logger.info("Total speakable words: %d", len(words))

    if not args.no_synth:
        ensure_audio(words, args.dry_run, client, bucket, resynth=args.resynth)
    else:
        logger.info("Skipping synthesis (--no-synth); missing files will be pulled from R2.")

    build_and_upload(words, dry_run=args.dry_run, client=client, bucket=bucket, force=args.force)

    if args.prune_files:
        if args.dry_run or client is None:
            logger.info("[DRY RUN] Skipping R2 prune.")
        else:
            prune_orphan_files(client, bucket, {w["audio_hash"] for w in words})

    logger.info("Audio sync complete.")


if __name__ == "__main__":
    main()
