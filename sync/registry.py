"""Content registry: word identity v2 + the language registry (WD-ID, LG-FR-9..15).

This module is the single home of:
  - the ID SCHEME (v2): stable, level-free word identity;
  - the LANGUAGE registry: which source languages exist, which fields each carries,
    which spreadsheet columns they read from, and their fallback base;
  - the TABLE registry: per-word-type core (German) fields and their columns;
  - the pinned NORMALIZATION rules feeding the ID hash.

Spreadsheet columns are matched by their ACTUAL header names (owner naming,
2026-07-18: German_Word, English_Word, ...; sheets renamed 2026-07-18 — no legacy
aliases, per owner decision). Each field keeps a TUPLE of accepted headers so a
future rename can overlap briefly, but today every tuple has exactly one entry.

ID SCHEME v2 (WD-ID-1/2/3):
  id = sha256("{type}|{word}|{article}|{sense}")[:16]   after normalize_for_id()
  - LEVEL-FREE: moving a word between CEFR levels keeps its identity (progress,
    media, approvals survive).
  - The named parts are the identity; SENSE disambiguates true homonyms
    (die See / der See). Two rows collapsing to one id is a VALIDATION ERROR
    telling the operator to add a Sense.
  - The language of the LEARNED word is deliberately absent (this app teaches
    German only — owner decision 2026-07-18); the scheme leaves room to add it
    as a fifth segment if that ever changes.
  - Spelling fixes CHANGE the id by design; the id_aliases table (old -> new)
    carries learner progress across (WD-ID-4).
Never change this scheme in place — a change is a new scheme version plus a
re-key migration (WD-ID-5).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field

ID_SCHEME_VERSION = 2

# ---------------------------------------------------------------------------
# Normalization (pinned — feeding the identity hash)
# ---------------------------------------------------------------------------

def normalize_for_id(text: str | None) -> str:
    """Pinned normalization for identity hashing: NFC unicode form, non-breaking
    spaces to spaces, trimmed, internal whitespace collapsed, casefolded.
    Capitalization fixes therefore KEEP a word's identity; spelling changes do not."""
    if not text:
        return ""
    t = unicodedata.normalize("NFC", str(text)).replace("\xa0", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t.casefold()


def compute_word_id(type_: str, word: str, article: str = "", sense: str = "") -> str:
    raw = "|".join((
        normalize_for_id(type_),
        normalize_for_id(word),
        normalize_for_id(article),
        normalize_for_id(sense),
    ))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def compute_legacy_id(level: str, word: str) -> str:
    """The v1 scheme — sha256('{level}|{word}' lowered)[:16]. Kept ONLY to build
    the id_aliases mapping and for the media pipeline until its P2 re-label."""
    raw = f"{level.lower()}|{word.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# Sense values: short lowercase tags ("lake", "sea"); empty = the only sense.
VALID_SENSE = re.compile(r"^[a-z0-9-]{1,24}$")

GERMAN_ARTICLES = {"der", "die", "das"}


# ---------------------------------------------------------------------------
# Language registry (LG-FR-10/11/12)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Language:
    code: str                       # BCP-47-ish: "en", "en-US", "es-MX", "zh"
    display: str                    # native display name
    base: str | None = None         # variant fallback (LG-FR-12): en-US -> en
    # field name -> accepted sheet headers, canonical FIRST then aliases
    columns: dict[str, tuple[str, ...]] = field(default_factory=dict)


# Fields a translation record may carry (superset across languages; schema columns).
TRANSLATION_FIELDS = ("word", "sentence", "article", "article_plural", "plural")

LANGUAGES: dict[str, Language] = {
    "en": Language("en", "English", columns={
        "word": ("English_Word",),
        "sentence": ("English_Sentence",),
    }),
    "en-US": Language("en-US", "English (US)", base="en", columns={
        "word": ("English_Word_US",),
        "sentence": ("English_Sentence_US",),
    }),
    "es-419": Language("es-419", "Español (Latinoamérica)", columns={
        "word": ("Spanish_Word_LatinAmerican",),
        "sentence": ("Spanish_Sentence_LatinAmerican",),
        "article": ("Spanish_Article_LatinAmerican",),
        "article_plural": ("Spanish_Article_Plural_LatinAmerican",),
        "plural": ("Spanish_Plural_LatinAmerican",),
    }),
    "es-MX": Language("es-MX", "Español (México)", base="es-419", columns={
        "word": ("Spanish_Word_Mexican",),
        "sentence": ("Spanish_Sentence_Mexican",),
        "article": ("Spanish_Article_Mexican",),
        "article_plural": ("Spanish_Article_Plural_Mexican",),
        "plural": ("Spanish_Plural_Mexican",),
    }),
    "es-ES": Language("es-ES", "Español (España)", base="es-419", columns={
        "word": ("Spanish_Word_Spain",),
        "sentence": ("Spanish_Sentence_Spain",),
        "article": ("Spanish_Article_Spain",),
        "article_plural": ("Spanish_Article_Plural_Spain",),
        "plural": ("Spanish_Plural_Spain",),
    }),
    "zh": Language("zh", "中文", columns={
        "word": ("Chinese_Word",),
        "sentence": ("Chinese_Sentence",),
    }),
}

# The language every word MUST have (the app's current studyable gate depends on
# it); all others are optional and surface through the coverage report (LG-FR-14).
REQUIRED_LANGUAGE = "en"


# ---------------------------------------------------------------------------
# Table registry (core German fields per word type)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Table:
    name: str                       # D1 table name
    xlsx: str                       # spreadsheet filename in data/
    allowed_types: frozenset[str]
    # core field (D1 column name) -> accepted sheet headers, canonical first
    columns: dict[str, tuple[str, ...]] = field(default_factory=dict)
    required: tuple[str, ...] = ()  # D1 columns that must be non-empty per row


_COMMON: dict[str, tuple[str, ...]] = {
    "level": ("Level",),
    "capital": ("Capital",),
    "type": ("Type",),
    "word": ("German_Word",),
    "sense": ("Sense",),                         # optional values; empty = the only sense
    "german_sentence": ("German_Sentence",),
}

TABLES: dict[str, Table] = {
    "verbs": Table(
        name="verbs", xlsx="verbs.xlsx", allowed_types=frozenset({"verb"}),
        columns={**_COMMON, **{
            c: (c if c != "sie_sie" else "sie_Sie",)
            for c in ("ich", "du", "er_sie_es", "wir", "ihr", "sie_sie",
                      "past_participle", "simple_past")
        }},
        required=("type", "german_sentence"),
    ),
    "nouns": Table(
        name="nouns", xlsx="nouns.xlsx", allowed_types=frozenset({"noun"}),
        columns={**_COMMON,
                 "article": ("German_Article",),
                 "plural": ("German_Plural",)},
        required=("type", "article", "german_sentence"),
    ),
    "adverbs_adjectives": Table(
        name="adverbs_adjectives", xlsx="adverbs_adjectives.xlsx",
        allowed_types=frozenset({"adverb", "adjective"}),
        columns={**_COMMON,
                 "comparative": ("German_Comparative",),
                 "superlative": ("German_Superlative",)},
        required=("type", "german_sentence"),
    ),
}

# Flag columns read explicitly by the ingest (not via the field registries).
SPECIAL_HEADERS = ("Image", "Free")

# Sheet columns that are operator/AI tooling, never content — recognized so the
# unknown-column warning stays MEANINGFUL (a typo'd language column must warn;
# these must not). Matched case-insensitively, prefix for the *_Fix_N family.
IGNORED_HEADER_PATTERNS = (
    re.compile(r"^(row_id|remarks|instructions for ai|claude|ajv)$", re.I),
    re.compile(r"^(ai_?\s?_?ignores?_\w+)$", re.I),
    re.compile(r"^claude_fix_\d+$", re.I),
    re.compile(r"^\w+_remarks(_scheme_[a-z])?$", re.I),
)


def is_ignored_header(header: str) -> bool:
    h = header.strip()
    return any(p.match(h) for p in IGNORED_HEADER_PATTERNS)


def known_headers_for(table: Table) -> set[str]:
    """Every header (canonical or alias) that carries content for this table."""
    known: set[str] = set()
    for names in table.columns.values():
        known.update(names)
    for lang in LANGUAGES.values():
        for names in lang.columns.values():
            known.update(names)
    known.update(SPECIAL_HEADERS)
    return known
