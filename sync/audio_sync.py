"""
Audio GENERATION pipeline: synthesize pronunciation audio (HE-AAC .m4a) for every
vocabulary word into the local cache + the durable R2 master mirror.

PUBLISHING IS NOT DONE HERE. media_publish.py is the sole publisher — it reads this
cache to build the immutable content-suffixed packs, the per-kind catalogs, the channel
manifests. The old pack-publish path
that lived here rewrote the shared manifest with name-keyed metas and could clobber
media_publish's output (audit 2026-07-19, H7); it was removed.

Runs alongside the text sync (sync.py). Reuses sync.py's Excel reader so it sees
exactly the same validated rows.

Design:
  - One HE-AAC .m4a per word, named "<id>.m4a". Nouns spoken as "<article> <word>";
    other types as the bare word (see audio_engine.synthesis_for).
  - Idempotent & durable: a local cache (audio_cache/) keyed by audio_hash means only
    new/changed words are re-synthesized, and every synthesized clip is mirrored to R2
    (audio/files/<audio_hash>.m4a). On a cache miss the canonical bytes are pulled from
    R2 rather than re-synthesized, so a recipe's audio is byte-stable forever — even on a
    fresh machine. (edge-tts is non-deterministic, so regeneration would otherwise yield
    different bytes.)

Environment (sync/.env):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

Usage:
  python audio_sync.py                # synthesize changed words → cache + master mirror
  python audio_sync.py --dry-run      # synthesize locally, upload nothing
  python audio_sync.py --resynth      # force fresh TTS for every word, then re-mirror
  python audio_sync.py --prune-files  # also delete orphaned masters from R2
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
import audio_overrides
import envs  # environment registry (audit MEDIA-022): the ONLY way to pick a bucket
import media_delivery  # shared .pack/manifest/R2 layer (also used by image_sync.py)
import sync  # reuse read_excel / TABLE_CONFIG / logging setup from the text pipeline

load_dotenv(Path(__file__).parent / ".env")   # Azure/TTS secrets only — bucket comes from envs

logger = logging.getLogger("audio_sync")

CACHE_DIR = Path(__file__).parent / "audio_cache"
INDEX_PATH = CACHE_DIR / "index.json"          # {id: audio_hash}
FILES_PREFIX = "audio/masters"                  # R2 prefix for the GENERATION safety net, keyed by the
                                                # synthesis-RECIPE hash (audio_hash): "give me the canonical
                                                # bytes for this recipe" so a fresh machine doesn't re-synthesize
                                                # non-deterministically. DISTINCT from the content-addressed
                                                # DELIVERY store audio/files/<content_hash>.m4a that
                                                # media_publish mirrors + the app fetches per-file (H6).
AUDIO_EXT = "m4a"                               # delivery format: HE-AAC mono (audio_engine.DELIVERY_KBPS)
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


def _row_descriptors(table: str, row: dict[str, Any]) -> list[dict[str, Any]]:
    """All audio descriptors for one vocabulary row, BEFORE overrides.

    Every word emits a "singular" descriptor. Nouns with a plural also emit "<id>_plural"
    (variant="plural"); any word with a German example sentence also emits "<id>_sentence"
    (variant="sentence"). Each: {id, level, kind, free, text, voice, audio_hash, variant}.
    Shared with media_replace.py so a replacement preview is built from EXACTLY the
    descriptors the real sync will use. Returns [] for a row with no speakable word.
    """
    spec = audio_engine.synthesis_for(table, row)
    if spec is None:
        return []
    wid = row["id"]
    level = (row.get("level") or "").strip().lower()
    kind = _kind_of(table, row)
    free = int(row.get("free") or 0)
    descs = [_descriptor(wid, level, kind, free, *spec, "singular")]

    # Extra spoken forms — each a variant id "<id>_<variant>" so it synthesizes, caches,
    # packs and re-syncs independently of the singular and of each other.
    if table == "nouns":
        pspec = audio_engine.plural_synthesis_for(row)
        if pspec is not None:
            descs.append(_descriptor(f"{wid}_plural", level, kind, free, *pspec, "plural"))
    sspec = audio_engine.sentence_synthesis_for(row)
    if sspec is not None:
        descs.append(_descriptor(f"{wid}_sentence", level, kind, free, *sspec, "sentence"))
    return descs


def apply_overrides(
    table: str, row: dict[str, Any], descs: list[dict[str, Any]], overrides: audio_overrides.Store
) -> None:
    """Apply any committed replacement overrides to a row's descriptors, in place.
    Clips without an override record are untouched — their hash stays byte-identical."""
    for d in descs:
        rec = overrides.get(d["id"])
        if rec:
            pool = audio_engine.voice_pool_for(table, row, d["variant"])
            audio_overrides.apply(d, rec, pool, (row.get("word") or "").strip())


def collect_words(overrides: audio_overrides.Store | None = None,
                  skip_invalid: bool = False) -> list[dict[str, Any]]:
    """Read every table and return the flat list of audio descriptors, with any
    committed replacement overrides (audio_overrides.json) already applied.
    skip_invalid mirrors sync.read_excel: invalid sheet rows are skipped (their
    previously synced audio is simply not part of this run)."""
    if overrides is None:
        overrides = audio_overrides.load()
    words: list[dict[str, Any]] = []
    rows_by_table: dict[str, list[dict[str, Any]]] = {}
    for table in sync.TABLE_CONFIG:
        rows, _, _ = sync.read_excel(table, skip_invalid=skip_invalid)
        rows_by_table[table] = rows
        logger.info("  %s: %d rows", table, len(rows))
        for row in rows:
            descs = _row_descriptors(table, row)
            if not descs:
                logger.warning("  skipping %s (no speakable word)", row.get("id"))
                continue
            apply_overrides(table, row, descs, overrides)
            words.extend(descs)

    # Ids are the audio cache keys and pack-member ids across ALL tables — a cross-table
    # collision would make two words fight over one clip. Guard here, where it would corrupt.
    problems = sync.find_cross_table_id_collisions(rows_by_table)
    if problems:
        raise sync.ValidationError(
            "cross-table id collision(s) — same Level+Word in two tables:\n  " + "\n  ".join(problems)
        )

    stale = set(overrides) - {w["id"] for w in words}
    if stale:
        logger.warning("audio_overrides.json has %d entr(y/ies) for unknown clip id(s): %s",
                       len(stale), ", ".join(sorted(stale)))
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
    return CACHE_DIR / f"{word_id}.{AUDIO_EXT}"


def _download_file(client, bucket: str, audio_hash: str, dest: Path) -> bool:
    """Pull a previously-synthesized audio master from R2 into the local cache. Returns True on
    success. This is what makes re-synthesis idempotent: the canonical bytes for a recipe live in R2
    (content-addressed by audio_hash) and are reused verbatim, never regenerated."""
    if client is None:
        return False
    return media_delivery.download_file(client, bucket, FILES_PREFIX, audio_hash, AUDIO_EXT, dest)


def _upload_file(client, bucket: str, audio_hash: str, src: Path) -> None:
    """Mirror a freshly-synthesized audio master to R2 so it never needs regenerating."""
    if client is None:
        return
    media_delivery.upload_file(client, bucket, FILES_PREFIX, audio_hash, AUDIO_EXT, src)


def _ensure_one(client, bucket: str | None, w: dict[str, Any], resynth: bool = False) -> str:
    """Produce the CURRENT clip for one word into the local cache. Returns "r2" | "tts".

    The caller only passes words whose audio_hash changed or whose clip is missing,
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
    """Ensure every word has its current clip in the local cache.

    A word is (re)processed when its cached audio_hash differs or its clip is
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


# ---------------------------------------------------------------------------
# R2 master mirror (the shared client/pack/manifest live in media_delivery)
# ---------------------------------------------------------------------------

def prune_orphan_files(client, bucket: str, live_hashes: set[str]) -> None:
    """Delete audio/files/<hash>.m4a masters no longer referenced by the current vocabulary
    (e.g. after a voice/recipe change orphans the previous clips)."""
    media_delivery.prune_orphan_files(client, bucket, FILES_PREFIX, AUDIO_EXT, live_hashes)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synthesize vocabulary audio into the local cache + durable master mirror. "
                    "GENERATION ONLY — publishing packs/manifests is media_publish.py's job.")
    parser.add_argument("--dry-run", action="store_true", help="Synthesize locally, upload nothing.")
    parser.add_argument("--no-synth", action="store_true", help="Skip synthesis (nothing to do without it).")
    parser.add_argument("--resynth", action="store_true",
                        help="Force fresh TTS for every word, ignoring the local cache AND R2 (then re-mirror).")
    parser.add_argument("--prune-files", action="store_true",
                        help="After synthesis, delete audio/files/ masters in R2 no longer referenced (orphans).")
    parser.add_argument("--env", choices=envs.environment_names(), default=None,
                        help="Target environment (default dev). Audit MEDIA-022: every R2-mutating "
                             "command resolves its bucket through the environment registry — never "
                             "through whatever the shared .env happens to name.")
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument("-v", "--verbose", action="store_true")
    verbosity.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    sync._setup_logging(args.verbose, args.quiet)

    # Environment registry (audit MEDIA-022): validates bucket/worker pairing and defaults
    # to dev; a prod bucket name in the shared .env can no longer be written by accident.
    try:
        env = envs.load_environment(args.env)
        if not args.dry_run and env.is_prod:
            action = "PRUNE unreferenced audio masters from the PRODUCTION bucket" if args.prune_files \
                else "upload audio masters into the PRODUCTION bucket"
            envs.confirm_production(env, action=action)
    except envs.EnvironmentError_ as exc:
        logger.error("%s", exc)
        sys.exit(1)

    if not args.dry_run:
        required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
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

    # One R2 client, shared by the durable audio-master mirror and the pack upload.
    client = None
    bucket = env.r2_bucket
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

    if args.prune_files:
        if args.dry_run or client is None:
            logger.info("[DRY RUN] Skipping R2 prune.")
        else:
            prune_orphan_files(client, bucket, {w["audio_hash"] for w in words})

    logger.info("Audio sync complete.")


if __name__ == "__main__":
    main()
