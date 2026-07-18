"""
Per-clip audio overrides — the durable, COMMITTED record of targeted audio replacements.

The audio pipeline is idempotent by recipe hash (audio_engine.audio_hash): same text + voice
= same clip forever. That is exactly right until a specific clip is BAD — then its recipe
must change or nothing re-ships (the pack hash and manifest version are built from recipe
hashes, so re-synthesizing the same recipe would update R2 yet never reach installed apps).

This store holds those deliberate recipe changes, keyed by DESCRIPTOR id (the pack-member
id: "<word_id>", "<word_id>_plural", "<word_id>_sentence"), one small JSON object each:

  take    int     re-take counter; enters the audio_hash and ROTATES the voice
                  deterministically within the clip's original pool (audio_engine.rotated_voice)
  voice   str?    explicit voice pin — overrides rotation (from the replacement sheet's Voice column)
  hint    str?    pronunciation respelling substituted for the word inside the spoken text

The file (sync/audio_overrides.json) MUST be committed, like image_decisions.json: a machine
without it would hash every replaced clip back to its old recipe and the next audio_sync run
would revert the packs to the old audio.

Written by media_replace.py (on --approve); read by audio_sync.collect_words, which applies
each record via apply() below. A missing file means no overrides (the common case) — and
apply() is never called for clips without a record, so untouched clips hash byte-identically
to a world where this module does not exist.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import audio_engine

OVERRIDES_PATH = Path(__file__).parent / "audio_overrides.json"

Override = dict[str, Any]
Store = dict[str, Override]


def load(path: Path = OVERRIDES_PATH) -> Store:
    """Load the overrides store; a missing file is the normal empty case."""
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001 — corrupt overrides must not silently revert audio
        raise RuntimeError(f"audio_overrides.json is unreadable ({exc}); fix or remove it before re-running.")


def save(store: Store, path: Path = OVERRIDES_PATH) -> None:
    """Persist deterministically (sorted keys) so diffs stay small and review-friendly."""
    path.write_text(json.dumps(store, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


def apply(desc: dict[str, Any], rec: Override, pool: list[str], word: str) -> None:
    """Apply one override record to one audio descriptor, in place.

    Order matters and mirrors what the hash covers:
      1. hint — respell the word inside the spoken text (all variants: "der Hund",
         the plural form, the example sentence) before anything is hashed
      2. voice — an explicit pin wins; otherwise a positive take rotates the voice
         deterministically within the clip's original pool
      3. audio_hash — recomputed over the final text + voice + take, which is what
         makes the replacement actually propagate (new master, new pack hash, new
         manifest version -> clients re-download just the affected packs)
    """
    take = int(rec.get("take") or 0)
    hint = (rec.get("hint") or "").strip()
    if hint and word:
        desc["text"] = re.sub(rf"\b{re.escape(word)}\b", hint, desc["text"], flags=re.IGNORECASE)
    if rec.get("voice"):
        desc["voice"] = rec["voice"]
    elif take > 0:
        desc["voice"] = audio_engine.rotated_voice(desc["voice"], pool, take)
    desc["take"] = take
    desc["audio_hash"] = audio_engine.audio_hash(desc["text"], desc["voice"], take)
