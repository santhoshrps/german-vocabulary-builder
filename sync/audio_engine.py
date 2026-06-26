"""
Reusable German TTS synthesis engine for the audio pipeline.

Adapted from flashcard-german/scripts/audio_synthesizer.py (the reference). Uses
the Azure Cognitive Services Speech SDK. The SDK natively handles a custom-domain
/ Azure AI Foundry resource (endpoint + key) — discovering the region and managing
auth tokens itself — which the plain REST API does not. This module is the pure,
reusable core: it turns one vocabulary row into (text, voice), hashes the synthesis
input deterministically, and renders an MP3. Orchestration (diffing, packing, R2
upload) lives in audio_sync.py.

Credentials (sync/.env):
  AZURE_SPEECH_KEY       resource key
  AZURE_SPEECH_ENDPOINT  Foundry / custom-domain URL (https://<name>.cognitiveservices.azure.com)
  AZURE_SPEECH_REGION    alternative to endpoint for a classic regional resource

Install:
  pip install azure-cognitiveservices-speech

Voices (one is picked per word from a gender-appropriate pool):
  der (masculine) -> a male voice pool
  die (feminine)  -> a female voice pool
  das (neuter)    -> Gisela + the male/female pools
  verb/adverb/adjective -> any voice
A few fixed words (hallo/willkommen/danke) get a specific voice.

Selection is DETERMINISTIC per word (seeded by the word text), not random: the
same word always maps to the same voice. This is required for the idempotent
audio cache — a truly random pick would change every word's audio_hash on every
run and re-synthesize the whole set.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

# The Azure Speech SDK is imported lazily inside the synthesis helpers so that
# hashing / pack building (and --dry-run / --no-synth) work without it installed.

# ── Voice pools ────────────────────────────────────────────────────────────────
# One voice is chosen per word from a gender-appropriate pool (see _pick_voice).
MASCULINE_VOICES = [
    "de-DE-ConradNeural", "de-DE-FlorianMultilingualNeural", "de-DE-BerndNeural",
    "de-DE-KasperNeural", "de-DE-KillianNeural",
    "de-DE-KlausNeural", "de-DE-RalfNeural",
]
FEMININE_VOICES = [
    "de-DE-KatjaNeural", "de-DE-SeraphinaMultilingualNeural", "de-DE-AmalaNeural",
    "de-DE-ElkeNeural", "de-DE-KlarissaNeural", "de-DE-LouisaNeural",
    "de-DE-MajaNeural", "de-DE-TanjaNeural",
]
NEUTER_VOICE = "de-DE-GiselaNeural"

# das (neuter) nouns: Gisela, or any male/female voice.
NEUTER_VOICES = [NEUTER_VOICE, *MASCULINE_VOICES, *FEMININE_VOICES]
# verbs / adjectives / adverbs: any voice.
ALL_VOICES = [*MASCULINE_VOICES, *FEMININE_VOICES, NEUTER_VOICE]

# Fixed overrides for a few specific words (matched case-insensitively on the word).
SPECIAL_WORD_VOICES = {
    "hallo": "de-DE-MajaNeural",
    "willkommen": "de-DE-GiselaNeural",
    "danke": "de-DE-RalfNeural",
}

# Voices removed from use. They are kept in the pools above ONLY so the modulo that
# assigns voices stays stable — _pick_voice skips them and re-assigns just the words
# that had landed on them, instead of reshuffling (and re-synthesizing) everything.
DISABLED_VOICES = {
    "de-DE-FlorianMultilingualNeural",
    "de-DE-SeraphinaMultilingualNeural",
}

# ── Prosody (slightly slower improves German phoneme clarity) ──────────────────
RATE = "-5%"
VOLUME = "+0%"
PITCH = "+0Hz"

# Identifies the synthesis recipe. Bump this when voices/prosody/text rules change
# so every word is re-synthesized (its audio_hash changes) on the next run.
# v2: per-word voice variety (pools instead of one voice per gender).
# v3: Azure Speech backend (different bytes than the old edge-tts engine).
# v4: Azure Speech SDK (handles the custom-domain Foundry resource natively).
ENGINE_VERSION = "4"


def _pick_voice(pool: list[str], seed: str) -> str:
    """Deterministically pick a voice from `pool` for a given word.

    Seeded by the word so the choice is stable across runs (idempotent cache) yet
    spread across the pool. NOT random — a random pick would re-synthesize the
    whole set every run.

    If the natural pick is a DISABLED voice, re-assign deterministically among the
    remaining voices of the same pool. Crucially, words whose natural pick is NOT
    disabled keep that exact voice — so disabling a voice only re-synthesizes the
    words that actually used it, not the whole set.
    """
    n = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:8], "big")
    primary = pool[n % len(pool)]
    if primary not in DISABLED_VOICES:
        return primary
    allowed = [v for v in pool if v not in DISABLED_VOICES]
    return allowed[n % len(allowed)]

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
    """Return (voice, resolved_article) for a noun — a per-word pick from the
    gender-appropriate pool."""
    art = (article or "").strip().lower()
    if art not in ("der", "die", "das"):
        art = detect_gender_fallback(noun)
    pool = {"der": MASCULINE_VOICES, "die": FEMININE_VOICES, "das": NEUTER_VOICES}[art]
    return _pick_voice(pool, noun.lower()), art


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

    # verbs, adverbs_adjectives (adjective + adverb) -> bare word, any-voice pool.
    # A few fixed words override the per-word pick.
    voice = SPECIAL_WORD_VOICES.get(word.lower()) or _pick_voice(ALL_VOICES, word.lower())
    return word, voice


def _variant_text_voice(text: str | None, seed: str | None = None) -> tuple[str, str] | None:
    """(text, voice) for an EXTRA spoken form (plural, sentence): an any-gender voice, picked
    deterministically (seeded by `seed`, or the text) so the audio_hash is stable across runs.
    Returns None when there is no text. Shared by plural_synthesis_for / sentence_synthesis_for so
    every extra form is produced the same way.
    """
    t = (text or "").strip()
    if not t:
        return None
    return t, _pick_voice(ALL_VOICES, (seed or t).lower())


def plural_synthesis_for(row: dict[str, Any]) -> tuple[str, str] | None:
    """Map a noun row to (text, voice) for its PLURAL pronunciation.

    Spoken as "die <plural>" — the German plural definite article is always "die", regardless of
    the singular's gender. The voice is an any-gender deterministic pick seeded by the plural form
    (so the audio_hash is stable). Returns None when the noun has no plural form.
    """
    plural = (row.get("plural") or "").strip()
    if not plural:
        return None
    return _variant_text_voice(f"die {plural}", seed=plural)


def sentence_synthesis_for(row: dict[str, Any]) -> tuple[str, str] | None:
    """Map any row to (text, voice) for its German EXAMPLE-SENTENCE pronunciation.

    Spoken verbatim (no added article), with an any-gender deterministic voice seeded by the
    sentence. Applies to every word type. Returns None when the word has no German sentence.
    """
    return _variant_text_voice(row.get("german_sentence"))


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


def _ssml(text: str, voice: str) -> str:
    """Build the SSML body for one utterance (text is XML-escaped)."""
    return (
        "<speak version='1.0' xml:lang='de-DE'>"
        f"<voice xml:lang='de-DE' name='{voice}'>"
        f"<prosody rate='{RATE}' volume='{VOLUME}' pitch='{PITCH}'>"
        f"{_xml_escape(text)}"
        "</prosody></voice></speak>"
    )


def _speech_config():
    """Build an Azure Speech SDK config from the environment.

    The SDK natively handles a custom-domain / Foundry resource via `endpoint` +
    key — it discovers the region and manages auth tokens itself, so we don't have
    to. A classic regional resource can use AZURE_SPEECH_REGION instead.
    """
    import azure.cognitiveservices.speech as speechsdk

    key = os.environ.get("AZURE_SPEECH_KEY")
    if not key:
        raise RuntimeError("AZURE_SPEECH_KEY must be set in sync/.env")
    endpoint = os.environ.get("AZURE_SPEECH_ENDPOINT")
    region = os.environ.get("AZURE_SPEECH_REGION")

    if endpoint:
        cfg = speechsdk.SpeechConfig(endpoint=endpoint.rstrip("/"), subscription=key)
    elif region:
        cfg = speechsdk.SpeechConfig(subscription=key, region=region)
    else:
        raise RuntimeError("Set AZURE_SPEECH_ENDPOINT (custom domain) or AZURE_SPEECH_REGION in sync/.env")

    # 24 kHz mono MP3 — plenty for single-word pronunciation, small files.
    cfg.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3
    )
    return cfg


def synthesize(text: str, voice: str, out_path: Path) -> None:
    """Render one MP3 to out_path via the Azure Speech SDK (blocking)."""
    import azure.cognitiveservices.speech as speechsdk

    corrected = apply_phoneme_corrections(text)
    synth = speechsdk.SpeechSynthesizer(speech_config=_speech_config(), audio_config=None)
    result = synth.speak_ssml_async(_ssml(corrected, voice)).get()

    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        details = result.cancellation_details
        raise RuntimeError(
            f"Azure TTS failed for voice {voice!r}: {details.reason} {details.error_details}"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(result.audio_data)
