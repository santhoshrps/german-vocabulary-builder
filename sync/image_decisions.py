"""
The image decisions store — the durable, COMMITTED record of which picture each noun got and whether
it is approved. This is what makes the pipeline idempotent (IMG-FR-STABLE-*): an approved image is
pinned by content hash + an input fingerprint, so a re-run reuses it unchanged unless the word's
content actually changed. The small JSON is committed; the heavy bytes live content-addressed in R2
(image/files/<hash>.heic) + the local image_cache, so a fresh checkout reconstructs everything
without re-reviewing 2,714 images.

Schema — `{ "<noun_id>": Decision }`, where Decision is:
  status            "approved" | "review" | "none"        # none = intentionally blank (ships no image)
  approved_by       "auto" | "human"                      # (approved only)
  source            "pixabay"|"pexels"|"openverse"|"wikimedia"|"generated:<model>"|"manual"
  source_id         provider id (or prompt hash for generated / "supplied" for manual)
  url               original URL (provenance)
  license           e.g. "Pixabay", "Pexels", "CC0", "PDM"  — redistribution-safe, no-attribution
  kind              "photo" | "illustration"
  content_hash      sha256 of the final HEIC  → the R2 key image/files/<hash>.heic + pack identity
  input_fingerprint sha256(gloss | word | german_sentence) — the inputs the image depends on
  verifier          {"correct": 0.97, "natural": 0.95, "appeal": 0.9}  (optional)
  updated           ISO date the decision last changed
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import image_config

Decision = dict[str, Any]
Store = dict[str, Decision]


# ---------------------------------------------------------------------------
# Load / save (committed JSON)
# ---------------------------------------------------------------------------

def load(path: Path = image_config.DECISIONS_PATH) -> Store:
    """Load the decisions store; a missing file is a fresh start ({})."""
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001 — a corrupt store is worth shouting about, not silently wiping
        raise RuntimeError(f"image_decisions.json is unreadable ({exc}); fix or remove it before re-running.")


def save(store: Store, path: Path = image_config.DECISIONS_PATH) -> None:
    """Persist the store deterministically (sorted keys) so diffs stay small and review-friendly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


# ---------------------------------------------------------------------------
# Input fingerprint — what the chosen image depends on (IMG-FR-STABLE-1/2)
# ---------------------------------------------------------------------------

def input_fingerprint(noun: dict[str, Any]) -> str:
    """Hash the noun fields a picture depends on: the English gloss (subject), the word
    (disambiguation/label), and the German example sentence (sense/scene). If any of these change the
    image is re-sourced; editing anything else (level, plural, …) does NOT churn the image.
    """
    gloss = (noun.get("english") or "").strip()
    word = (noun.get("word") or "").strip()
    sentence = (noun.get("german_sentence") or "").strip()
    payload = f"{gloss}\n{word}\n{sentence}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Idempotency queries
# ---------------------------------------------------------------------------

def is_settled_current(store: Store, noun: dict[str, Any]) -> bool:
    """True when this noun's image work is already done for its CURRENT content, so it must not be
    generated again: `approved` / `none` (terminal), or `review` (candidates already generated and
    waiting for a human) — in each case only while the `input_fingerprint` still matches. A content
    change (different fingerprint) is NEVER settled, so the image IS regenerated.
    """
    rec = store.get(noun["id"])
    if not rec or rec.get("status") not in ("approved", "none", "review"):
        return False
    return rec.get("input_fingerprint") == input_fingerprint(noun)


def needs_processing(store: Store, noun: dict[str, Any]) -> bool:
    """Inverse of `is_settled_current` — this noun must be (re)generated this run."""
    return not is_settled_current(store, noun)


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------

def record_approved(
    store: Store, noun: dict[str, Any], *, source: str, source_id: str, url: str, license: str,
    kind: str, content_hash: str, approved_by: str, today: str, verifier: dict[str, float] | None = None,
) -> Decision:
    """Pin an approved picture for a noun (auto or human). `today` is passed in (ISO date) so this
    module stays pure/testable."""
    rec: Decision = {
        "status": "approved",
        "approved_by": approved_by,
        "source": source,
        "source_id": source_id,
        "url": url,
        "license": license,
        "kind": kind,
        "content_hash": content_hash,
        "encoder": "sips",   # masters are now Apple-encoded HEIC; lets the re-encode migration skip them
        "input_fingerprint": input_fingerprint(noun),
        "updated": today,
    }
    if verifier is not None:
        rec["verifier"] = {k: round(float(v), 3) for k, v in verifier.items()}
    store[noun["id"]] = rec
    return rec


def mark_review(store: Store, noun: dict[str, Any], today: str) -> Decision:
    """Queue a noun for human review (no shipped image yet)."""
    rec: Decision = {
        "status": "review",
        "input_fingerprint": input_fingerprint(noun),
        "updated": today,
    }
    store[noun["id"]] = rec
    return rec


def mark_none(store: Store, noun: dict[str, Any], today: str) -> Decision:
    """Record an intentional blank (nothing qualified / reviewer chose none) — ships no image."""
    rec: Decision = {
        "status": "none",
        "input_fingerprint": input_fingerprint(noun),
        "updated": today,
    }
    store[noun["id"]] = rec
    return rec


def prune(store: Store, live_ids: set[str]) -> int:
    """Drop decisions for nouns no longer flagged/present. Returns how many were removed."""
    stale = [nid for nid in store if nid not in live_ids]
    for nid in stale:
        store.pop(nid, None)
    return len(stale)


# ---------------------------------------------------------------------------
# Views for the builder
# ---------------------------------------------------------------------------

def approved(store: Store) -> Store:
    """Only the approved decisions (those that contribute a pack member)."""
    return {nid: rec for nid, rec in store.items() if rec.get("status") == "approved"}


def live_content_hashes(store: Store) -> set[str]:
    """Content hashes still referenced by an approved decision — the masters to keep (prune the rest)."""
    return {rec["content_hash"] for rec in store.values()
            if rec.get("status") == "approved" and rec.get("content_hash")}


# ---------------------------------------------------------------------------
# Per-noun prompt options (survive regeneration — kept separate from the decision,
# which is overwritten each run). e.g. {"<noun_id>": {"no_sentence": true}}
# ---------------------------------------------------------------------------

PROMPT_OPTS_PATH = image_config.SYNC_DIR / "image_prompt_opts.json"


def load_prompt_opts(path: Path = PROMPT_OPTS_PATH) -> dict[str, dict]:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:  # noqa: BLE001 — a broken opts file shouldn't block sourcing
        return {}


def save_prompt_opts(opts: dict[str, dict], path: Path = PROMPT_OPTS_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(opts, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


def uses_sentence(opts: dict[str, dict], noun_id: str) -> bool:
    """Whether the example sentence should be fed to image generation for this noun (default yes)."""
    return not opts.get(noun_id, {}).get("no_sentence", False)


def set_no_sentence(opts: dict[str, dict], noun_id: str, value: bool = True) -> None:
    """Record (or clear) 'do not use the sentence in generation' for one noun."""
    rec = opts.setdefault(noun_id, {})
    if value:
        rec["no_sentence"] = True
    else:
        rec.pop("no_sentence", None)
        if not rec:
            opts.pop(noun_id, None)


def get_note(opts: dict[str, dict], noun_id: str) -> str:
    """Reviewer feedback appended to the generation prompt for this noun (e.g. 'show the full
    head, not cropped' / 'make the car a red Porsche'). Empty string when none."""
    return (opts.get(noun_id, {}).get("note") or "").strip()


def set_note(opts: dict[str, dict], noun_id: str, note: str | None) -> None:
    """Record (or clear) the per-noun generation feedback note."""
    note = (note or "").strip()
    rec = opts.setdefault(noun_id, {})
    if note:
        rec["note"] = note
    else:
        rec.pop("note", None)
        if not rec:
            opts.pop(noun_id, None)
