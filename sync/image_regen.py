"""
Per-word image regenerate — redo the picture for one or a few specific nouns on demand.

Overrides the approval pin for just those nouns (IMG-FR-REGEN-*) and redoes them one of three ways,
then republishes so only those images change (the app re-downloads just those files next sync):

  python image_regen.py "die Stadt" --regenerate # remove the current picture + generate fresh → review
  python image_regen.py "die Stadt" --remove      # remove the current picture and keep it removed
  python image_regen.py Hund Apfel              # re-search fresh stock + re-rank/verify (default)
  python image_regen.py Hund --generate         # generate (photo-real, then illustration) via Foundry
  python image_regen.py Hund --generate --style illustration --prompt "a friendly cartoon dog"
  python image_regen.py Apfel --image ./apple.jpg     # supply your own (file or URL) — hand-curated

Targets may be the German word (case-insensitive) or the noun id. Re-search results that aren't
confidently auto-approved go to the review queue (open image_review.py). --generate / --image are
treated as your explicit choice and approved directly. --regenerate redoes via generation-first and
queues the new candidate(s) for review; --remove drops the picture (app stops showing it next sync)
and deletes its now-orphaned master from R2. Add --dry-run to preview without uploading.

Keys (sync/.env): R2_*, plus PIXABAY/PEXELS (re-search) or AZURE_FOUNDRY_* (generate).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

import image_config as cfg
import image_decisions
import image_engine
import image_sources
import image_sync
import media_delivery
import sync

load_dotenv(Path(__file__).parent / ".env")
logger = logging.getLogger("image_regen")


def _resolve(targets: list[str], nouns: list[dict]) -> list[dict]:
    """Match each target to a flagged noun: by noun id, by the bare German word, or by the
    article-prefixed form (e.g. both 'Stadt' and 'die Stadt' resolve) — all case-insensitive."""
    by_word = {(n.get("word") or "").lower(): n for n in nouns}
    by_article_word = {f"{(n.get('article') or '').lower()} {(n.get('word') or '').lower()}".strip(): n
                       for n in nouns}
    by_id = {n["id"]: n for n in nouns}
    out, miss = [], []
    for t in targets:
        key = t.lower().strip()
        n = by_id.get(t) or by_word.get(key) or by_article_word.get(key)
        (out if n else miss).append(n or t)
    if miss:
        logger.error("Not found among image-flagged nouns: %s", ", ".join(str(m) for m in miss))
    return [n for n in out if isinstance(n, dict)]


def _approve(store, queue, noun, master, *, source, source_id, url, license, kind, client, bucket, dry_run):
    """Record an approved (human) image for a noun, write/upload its HEIC master, clear any review entry."""
    h = image_engine._content_hash(master)
    image_sync._write_master(master, h)
    if not dry_run and client is not None:
        media_delivery.upload_file(client, bucket, cfg.FILES_PREFIX, h, cfg.FILE_EXT, image_sync._master_path(h))
    image_decisions.record_approved(store, noun, source=source, source_id=source_id, url=url,
                                    license=license, kind=kind, content_hash=h, approved_by="human",
                                    today=date.today().isoformat())
    queue.pop(noun["id"], None)
    logger.info("  approved %s (%s) ← %s", noun.get("word"), h[:8], source)


def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate the image for specific noun(s).")
    parser.add_argument("targets", nargs="+", help="German word(s) or noun id(s).")
    parser.add_argument("--generate", action="store_true", help="Generate via Foundry instead of stock search.")
    parser.add_argument("--style", choices=["photo", "illustration"], help="Generation style (default: ladder).")
    parser.add_argument("--prompt", help="Custom generation prompt (implies --generate).")
    parser.add_argument("--image", help="Supply your own image (local file path or URL).")
    parser.add_argument("--remove", action="store_true",
                        help="Remove the current picture for the word(s) and keep it removed (no regenerate).")
    parser.add_argument("--regenerate", action="store_true",
                        help="Remove the current picture, then generate fresh candidate(s) for review (generation-first).")
    parser.add_argument("--dry-run", action="store_true", help="Update decisions locally; upload nothing.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    sync._setup_logging(args.verbose, False)

    bucket = os.environ.get("R2_BUCKET")
    client = None
    if not args.dry_run:
        if not all(os.environ.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")):
            logger.error("R2 not configured — set R2_* in sync/.env (or use --dry-run).")
            sys.exit(1)
        client = media_delivery.r2_client()

    nouns = image_sync.collect_nouns()
    targets = _resolve(args.targets, nouns)
    if not targets:
        sys.exit(1)

    store = image_decisions.load()
    queue = image_sync._load_review_queue()
    opts = image_decisions.load_prompt_opts()
    removed_hashes: list[str] = []   # old masters to garbage-collect from R2 once they're unreferenced

    for noun in targets:
        nid = noun["id"]
        old_hash = (store.get(nid) or {}).get("content_hash")
        verb = "Removing" if (args.remove and not args.regenerate) else "Regenerating"
        logger.info("%s %s (%s)…", verb, noun.get("word"), noun.get("english"))
        store.pop(nid, None)  # override the pin
        if old_hash:
            removed_hashes.append(old_hash)

        if args.remove or args.regenerate:
            queue.pop(nid, None)
            today = date.today().isoformat()
            if args.regenerate:
                outcome = image_engine.process_noun(
                    noun,
                    use_sentence=image_decisions.uses_sentence(opts, nid),
                    note=image_decisions.get_note(opts, nid),
                )
                if outcome.status == "review":
                    for pc in outcome.candidates:
                        image_sync._write_master(pc.master, pc.content_hash)
                        if not args.dry_run and client is not None:
                            media_delivery.upload_file(client, bucket, cfg.FILES_PREFIX, pc.content_hash,
                                                       cfg.FILE_EXT, image_sync._master_path(pc.content_hash))
                    image_decisions.mark_review(store, noun, today)
                    queue[nid] = image_sync._queue_entry(noun, outcome)
                    logger.info("  removed old picture → regenerated %d candidate(s); run image_review.py to pick",
                                len(outcome.candidates))
                else:
                    image_decisions.mark_none(store, noun, today)
                    logger.info("  removed old picture; generation produced nothing — left without an image")
            else:  # --remove only: mark settled-none so the main run won't auto-regenerate it
                image_decisions.mark_none(store, noun, today)
                logger.info("  removed the picture (kept removed; re-run with --regenerate to remake it)")
            continue

        if args.image:
            raw = (image_sources.fetch_image_bytes(args.image) if args.image.startswith(("http://", "https://"))
                   else Path(args.image).read_bytes())
            raw = image_engine.autotrim_borders(raw)   # strip any letterbox/matte so it fills the slot
            master, jpeg = image_engine.process_for_approval(raw)
            if not image_engine.content_safe(jpeg):
                logger.error("  supplied image failed content safety — skipping %s", noun.get("word"))
            else:
                _approve(store, queue, noun, master, source="manual", source_id="supplied", url=args.image,
                         license="manual", kind="photo", client=client, bucket=bucket, dry_run=args.dry_run)

        elif args.generate or args.prompt:
            # A custom prompt drives a single attempt (default style photo); otherwise walk the ladder.
            styles = [args.style or "photo"] if args.prompt else ([args.style] if args.style else cfg.GENERATION_STYLES)
            done = False
            for style in styles:
                raw = image_engine.generate(noun, style, prompt=args.prompt)
                if raw is None:
                    continue
                master, jpeg = image_engine.process_for_approval(raw)
                if not image_engine.content_safe(jpeg):
                    logger.warning("  generated %s failed content safety — trying next", style)
                    continue
                _approve(store, queue, noun, master, source=f"generated:{cfg.env('AZURE_FOUNDRY_IMAGE_MODEL', cfg.IMAGE_GEN_MODEL)}",
                         source_id=f"{noun['id']}:{style}", url="", license="generated",
                         kind=("photo" if style == "photo" else "illustration"),
                         client=client, bucket=bucket, dry_run=args.dry_run)
                done = True
                break
            if not done:
                logger.error("  generation produced nothing usable for %s", noun.get("word"))

        else:  # default: re-search fresh stock and run the normal funnel
            outcome = image_engine.process_noun(noun, allow_generation=False)
            today = date.today().isoformat()
            if outcome.status == "approved":
                pc = outcome.chosen
                _approve(store, queue, noun, pc.master, source=pc.candidate.source, source_id=pc.candidate.source_id,
                         url=pc.candidate.page_url or pc.candidate.image_url, license=pc.candidate.license,
                         kind=pc.kind, client=client, bucket=bucket, dry_run=args.dry_run)
            elif outcome.status == "review":
                for pc in outcome.candidates:
                    image_sync._write_master(pc.master, pc.content_hash)
                image_decisions.mark_review(store, noun, today)
                queue[noun["id"]] = image_sync._queue_entry(noun, outcome)
                logger.info("  → queued for review (%d candidates) — run image_review.py", len(outcome.candidates))
            else:
                image_decisions.mark_none(store, noun, today)
                queue.pop(noun["id"], None)
                logger.info("  ∅ no suitable image found")

    image_decisions.save(store)
    image_sync._save_review_queue(queue)

    # Republish so the changed images propagate (only changed packs upload). Reuses image_sync's
    # build+publish (no re-sourcing).
    logger.info("Republishing image packs…")
    image_sync.run(dry_run=args.dry_run, no_source=True, limit=0, force=False, prune_files=False,
                   client=client, bucket=bucket)

    # Delete each removed picture's master from R2 — but only once nothing references it anymore
    # (the same hash may still be approved/queued for another noun, or be a freshly-regenerated one).
    if removed_hashes and not args.dry_run and client is not None:
        final_store = image_decisions.load()
        final_queue = image_sync._load_review_queue()
        referenced = set(image_decisions.live_content_hashes(final_store))
        for e in final_queue.values():
            referenced.update(c.get("content_hash") for c in e.get("candidates", []))
        gone = 0
        for h in {h for h in removed_hashes if h not in referenced}:
            try:
                client.delete_object(Bucket=bucket, Key=f"{cfg.FILES_PREFIX}/{h}.{cfg.FILE_EXT}")
                gone += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("  could not delete old master %s in R2 (%s)", h[:8], exc)
        if gone:
            logger.info("Deleted %d orphaned image master(s) from R2.", gone)

    logger.info("Regenerate complete.")


if __name__ == "__main__":
    main()
