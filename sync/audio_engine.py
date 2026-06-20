"""
Reusable German TTS synthesis engine for the audio pipeline.

Adapted from flashcard-german/scripts/audio_synthesizer.py (the reference). Uses
edge-tts (Microsoft Edge Neural voices) — free, no API key. This module is the
pure, reusable core: it knows how to turn one vocabulary row into (text, voice),
hash the synthesis input deterministically, and render an MP3. Orchestration
(diffing, packing, R2 upload) lives in audio_sync.py.

Voices:
  der (masculine) -> de-DE-KillianNeural   (adult male)
  die (feminine)  -> de-DE-KatjaNeural     (adult female)
  das (neuter)    -> de-DE-SeraphinaMultilingualNeural (child/girl)
  verb/adverb/adjective -> de-DE-ConradNeural (neutral male narrator)

Install:
  pip install edge-tts
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from typing import Any

# edge_tts is imported lazily inside synthesize() so that hashing / pack building
# (and --dry-run / --no-synth) work without the TTS dependency installed.

# ── Voice mapping ──────────────────────────────────────────────────────────────
VOICE_MASCULINE = "de-DE-KillianNeural"                  # der
VOICE_FEMININE = "de-DE-KatjaNeural"                     # die
VOICE_CHILD = "de-DE-SeraphinaMultilingualNeural"        # das
VOICE_NEUTRAL = "de-DE-ConradNeural"                     # verb / adverb / adjective

# ── Prosody (slightly slower improves German phoneme clarity) ──────────────────
RATE = "-5%"
VOLUME = "+0%"
PITCH = "+0Hz"

# Identifies the synthesis recipe. Bump this when voices/prosody/text rules change
# so every word is re-synthesized (its audio_hash changes) on the next run.
ENGINE_VERSION = "1"

# ── German phoneme corrections applied before synthesis ────────────────────────
PHONEME_MAP = {
    "ß": "ss",
    "ae": "ä",
    "oe": "ö",
    "ue": "ü",
}

# Per-word pronunciation overrides: { "word": "replacement text" }
PRONUNCIATION_HINTS: dict[str, str] = {}

# ── Gender detection fallback (when article is missing/unrecognised) ───────────
MASCULINE_SUFFIXES = ("er", "ling", "ismus", "or", "ig", "ner", "eur")
FEMININE_SUFFIXES = ("ung", "heit", "keit", "schaft", "ion", "ät", "enz",
                     "ie", "ik", "in", "tur", "ur")
NEUTER_SUFFIXES = ("chen", "lein", "um", "ment", "nis", "tum")


def apply_phoneme_corrections(text: str) -> str:
    """Apply known German phoneme corrections before synthesis."""
    for wrong, right in PHONEME_MAP.items():
        text = text.replace(wrong, right)
    for word, hint in PRONUNCIATION_HINTS.items():
        text = re.sub(rf"\b{re.escape(word)}\b", hint, text, flags=re.IGNORECASE)
    return text


def detect_gender_fallback(noun: str) -> str:
    """Return an article guess from noun morphology."""
    n = noun.lower()
    for suf in NEUTER_SUFFIXES:
        if n.endswith(suf):
            return "das"
    for suf in FEMININE_SUFFIXES:
        if n.endswith(suf):
            return "die"
    for suf in MASCULINE_SUFFIXES:
        if n.endswith(suf):
            return "der"
    return "der"


def _voice_for_article(article: str | None, noun: str) -> tuple[str, str]:
    """Return (voice, resolved_article) for a noun."""
    art = (article or "").strip().lower()
    if art not in ("der", "die", "das"):
        art = detect_gender_fallback(noun)
    voice = {"der": VOICE_MASCULINE, "die": VOICE_FEMININE, "das": VOICE_CHILD}[art]
    return voice, art


def synthesis_for(table: str, row: dict[str, Any]) -> tuple[str, str] | None:
    """Map a validated DB-column row to (text, voice) for synthesis.

    Nouns are spoken as "<article> <word>"; verbs/adverbs/adjectives as the bare
    word. Returns None when the row has no speakable word.
    """
    word = (row.get("word") or "").strip()
    if not word:
        return None

    if table == "nouns":
        voice, article = _voice_for_article(row.get("article"), word)
        return f"{article} {word}", voice

    # verbs, adverbs_adjectives (adjective + adverb) -> neutral narrator, word only
    return word, VOICE_NEUTRAL


def audio_hash(text: str, voice: str) -> str:
    """Deterministic hash of the synthesis *input* (text + voice + recipe).

    Lets the pipeline decide whether a word needs (re)synthesis WITHOUT calling
    the TTS service: same input -> same hash -> reuse the cached MP3. Changing a
    word's example sentence (which is not part of the spoken text) does not change
    this hash, so audio is not needlessly regenerated.
    """
    corrected = apply_phoneme_corrections(text)
    payload = f"{ENGINE_VERSION}|{voice}|{RATE}|{VOLUME}|{PITCH}|{corrected}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def _synthesize_async(text: str, voice: str, out_path: Path) -> None:
    import edge_tts  # lazy: only needed when actually synthesizing

    corrected = apply_phoneme_corrections(text)
    communicate = edge_tts.Communicate(corrected, voice, rate=RATE, volume=VOLUME, pitch=PITCH)
    await communicate.save(str(out_path))


def synthesize(text: str, voice: str, out_path: Path) -> None:
    """Render one MP3 to out_path (blocking; runs its own event loop)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    asyncio.run(_synthesize_async(text, voice, out_path))
