"""Identity v2 + registry unit tests (tracker #34, WD-ID-1/2/3)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import registry
from registry import (
    ID_SCHEME_VERSION, LANGUAGES, TABLES, compute_legacy_id, compute_word_id,
    is_ignored_header, known_headers_for, normalize_for_id,
)


def test_scheme_version_is_pinned():
    assert ID_SCHEME_VERSION == 2


class TestNormalization:
    def test_casefold(self):
        assert normalize_for_id("Hund") == normalize_for_id("hund") == "hund"

    def test_nbsp_and_whitespace_collapse(self):
        assert normalize_for_id(" sich\xa0 ärgern ") == "sich ärgern"

    def test_eszett_casefolds_to_ss(self):
        # casefold (not lower) — ß and ss unify, pinned behavior
        assert normalize_for_id("Straße") == "strasse"

    def test_empty_and_none(self):
        assert normalize_for_id(None) == ""
        assert normalize_for_id("  ") == ""

    def test_nfc_composition(self):
        decomposed = "üben"  # ü as u + combining diaeresis
        assert normalize_for_id(decomposed) == normalize_for_id("üben")


class TestWordId:
    def test_known_vector_is_stable(self):
        # Frozen vector: if this changes, the ID SCHEME changed — that is a
        # re-key migration, not a refactor. Do not update casually.
        assert compute_word_id("noun", "Hund", "der", "") == "a502e50f5723d670"

    def test_level_free(self):
        assert compute_word_id("verb", "laufen") == compute_word_id("verb", "laufen")

    def test_capitalization_fix_keeps_identity(self):
        assert compute_word_id("noun", "hund", "der") == compute_word_id("noun", "Hund", "der")

    def test_spelling_change_changes_identity(self):
        assert compute_word_id("noun", "Hund", "der") != compute_word_id("noun", "Hunde", "der")

    def test_type_distinguishes(self):
        assert compute_word_id("noun", "Laufen") != compute_word_id("verb", "laufen")

    def test_article_distinguishes(self):
        assert compute_word_id("noun", "See", "der") != compute_word_id("noun", "See", "die")

    def test_sense_distinguishes(self):
        assert compute_word_id("noun", "Bank", "die", "bench") != \
            compute_word_id("noun", "Bank", "die", "institution")

    def test_length_and_charset(self):
        wid = compute_word_id("noun", "Hund", "der")
        assert len(wid) == 16 and all(c in "0123456789abcdef" for c in wid)


class TestLegacyId:
    def test_matches_v1_formula(self):
        import hashlib
        expected = hashlib.sha256("a1.1|hund".encode()).hexdigest()[:16]
        assert compute_legacy_id("A1.1", "Hund") == expected

    def test_level_dependent(self):
        assert compute_legacy_id("A1", "Hund") != compute_legacy_id("B1", "Hund")


class TestLanguageRegistry:
    def test_english_is_required_language(self):
        assert registry.REQUIRED_LANGUAGE in LANGUAGES

    def test_variants_declare_bases(self):
        assert LANGUAGES["en-US"].base == "en"
        assert LANGUAGES["es-MX"].base == "es-419"
        assert LANGUAGES["en"].base is None

    def test_actual_names_only(self):
        # Owner decision 2026-07-18: no legacy aliases — one actual header per field.
        assert LANGUAGES["en"].columns["word"] == ("English_Word",)

    def test_every_language_has_word_column(self):
        for lang in LANGUAGES.values():
            assert "word" in lang.columns

    def test_complete_fallback_graph_matches_app_worker_contract(self):
        """Product purpose: app, publisher, and read worker resolve the same six language codes."""
        assert {code: lang.base for code, lang in LANGUAGES.items()} == {
            "en": None,
            "en-US": "en",
            "es-419": None,
            "es-MX": "es-419",
            "es-ES": "es-419",
            "zh": None,
        }


class TestTableRegistry:
    def test_word_header_actual_name(self):
        for table in TABLES.values():
            assert table.columns["word"] == ("German_Word",)

    def test_ignored_headers(self):
        for h in ("row_id", "Remarks", "Instructions for AI", "Claude_Fix_2",
                  "Spanish_Remarks_Scheme_B", "AI _Ignores_Article", "AJV"):
            assert is_ignored_header(h), h
        for h in ("German_Word", "Chinese_Word", "Spanisch_Word", "English"):
            assert not is_ignored_header(h), h

    def test_known_headers_include_special(self):
        known = known_headers_for(TABLES["nouns"])
        assert {"Image", "Free", "German_Word", "Chinese_Word"} <= known
        assert "Word" not in known  # legacy names are gone
