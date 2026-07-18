"""V2 dataset reader tests (tracker #34): pivot, validation, aliases, coverage.

Each test builds a real .xlsx in a temp dir and points dataset.DATA_DIR at it —
the reader is exercised through the same openpyxl path production uses.
"""

import sys
from pathlib import Path

import openpyxl
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import dataset
from dataset import ValidationError, read_dataset
from registry import compute_legacy_id, compute_word_id

NOUN_HEADERS = [
    "Level", "Capital", "Type", "Free", "Image", "German_Article", "German_Word",
    "German_Plural", "German_Sentence", "English_Word", "English_Sentence",
    "English_Word_US", "Chinese_Word", "Chinese_Sentence", "Remarks",
]


def make_sheet(tmp_path, filename, headers, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append([row.get(h) for h in headers])
    wb.save(tmp_path / filename)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(dataset, "DATA_DIR", tmp_path)
    return tmp_path


def noun_row(**overrides):
    base = {
        "Level": "A1.1", "Type": "noun", "German_Article": "der", "German_Word": "Hund",
        "German_Plural": "Hunde", "German_Sentence": "Der Hund bellt.",
        "English_Word": "dog", "English_Sentence": "The dog barks.",
        "Free": 1, "Image": "y",
    }
    base.update(overrides)
    return base


class TestHappyPath:
    def test_core_translations_aliases(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [
            noun_row(),
            noun_row(German_Word="Katze", German_Article="die", German_Plural="Katzen",
                     German_Sentence="Die Katze schläft.", English_Word="cat",
                     English_Sentence="The cat sleeps.", Chinese_Word="猫",
                     Chinese_Sentence="猫在睡觉。", Free=0, Image=None),
        ])
        ds = read_dataset("nouns")
        assert len(ds.core) == 2 and ds.skipped == 0

        hund = next(r for r in ds.core if r["word"] == "Hund")
        assert hund["id"] == compute_word_id("noun", "Hund", "der", "")
        assert hund["free"] == 1 and hund["image"] == 1
        assert "english" not in hund  # translations are rows, not columns

        katze = next(r for r in ds.core if r["word"] == "Katze")
        t = {(r["lang"], r["word"]) for r in ds.translations if r["word_id"] == katze["id"]}
        assert ("en", "cat") in t and ("zh", "猫") in t
        assert ds.coverage["en"] == 2 and ds.coverage["zh"] == 1

        alias = next(a for a in ds.aliases if a["new_id"] == hund["id"])
        assert alias["id"] == compute_legacy_id("A1.1", "Hund")
        assert alias["reason"] == "v2-rekey"

    def test_translation_row_ids_composite(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row()])
        ds = read_dataset("nouns")
        for row in ds.translations:
            assert row["id"] == f"{row['word_id']}:{row['lang']}"

    def test_noun_capitalization_at_ingest(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS,
                   [noun_row(German_Word="hund", German_Plural="die hunde")])
        ds = read_dataset("nouns")
        assert ds.core[0]["word"] == "Hund"
        assert ds.core[0]["plural"] == "die Hunde"

    def test_legacy_headers_rejected(self, data_dir):
        # Owner decision 2026-07-18: actual names only — a sheet still carrying the
        # old 'Word' header must fail (missing required column), not silently read.
        headers = [h.replace("German_Word", "Word") for h in NOUN_HEADERS]
        make_sheet(data_dir, "nouns.xlsx", headers, [noun_row()])
        with pytest.raises(ValidationError, match="German_Word"):
            read_dataset("nouns")

    def test_variant_sparse_and_coverage(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [
            noun_row(English_Word_US="hound"),
            noun_row(German_Word="Katze", German_Article="die", English_Word="cat",
                     German_Sentence="x", English_Sentence="y"),
        ])
        ds = read_dataset("nouns")
        us = [r for r in ds.translations if r["lang"] == "en-US"]
        assert len(us) == 1 and us[0]["word"] == "hound"
        assert ds.coverage["en"] == 2 and ds.coverage["en-US"] == 1


class TestValidation:
    def test_homonym_collision_is_error_and_sense_fixes_it(self, data_dir):
        headers = NOUN_HEADERS + ["Sense"]
        make_sheet(data_dir, "nouns.xlsx", headers, [
            noun_row(German_Word="Bank", German_Article="die", English_Word="bench"),
            noun_row(German_Word="Bank", German_Article="die", English_Word="bank"),
        ])
        with pytest.raises(ValidationError, match="Sense"):
            read_dataset("nouns")

        make_sheet(data_dir, "nouns.xlsx", headers, [
            noun_row(German_Word="Bank", German_Article="die", English_Word="bench", Sense="bench"),
            noun_row(German_Word="Bank", German_Article="die", English_Word="bank", Sense="institution"),
        ])
        ds = read_dataset("nouns")
        assert len(ds.core) == 2
        assert len({r["id"] for r in ds.core}) == 2

    def test_same_word_two_levels_collides(self, data_dir):
        # Level-free identity: the same word at two levels is ONE identity now.
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [
            noun_row(Level="A1.1"), noun_row(Level="B1"),
        ])
        with pytest.raises(ValidationError, match="collapse to ONE identity"):
            read_dataset("nouns")

    def test_article_validation(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row(German_Article="dem")])
        with pytest.raises(ValidationError, match="Article"):
            read_dataset("nouns")

    def test_slash_articles_allowed(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [
            noun_row(German_Word="Mitarbeitende", German_Article="der/die"),
            noun_row(German_Word="Joghurt", German_Article="der/die/das"),
        ])
        ds = read_dataset("nouns")
        assert len(ds.core) == 2

    def test_repeated_slash_article_rejected(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row(German_Article="der/der")])
        with pytest.raises(ValidationError, match="Article"):
            read_dataset("nouns")

    def test_english_required(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row(English_Word=None)])
        with pytest.raises(ValidationError, match="English word"):
            read_dataset("nouns")

    def test_invalid_sense_tag(self, data_dir):
        headers = NOUN_HEADERS + ["Sense"]
        make_sheet(data_dir, "nouns.xlsx", headers, [noun_row(Sense="Bad Sense!")])
        with pytest.raises(ValidationError, match="Sense"):
            read_dataset("nouns")

    def test_duplicated_column_is_error(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS + ["German_Word"],
                   [noun_row()])
        with pytest.raises(ValidationError, match="duplicated column"):
            read_dataset("nouns")

    def test_skip_invalid_protects_everywhere(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [
            noun_row(),
            noun_row(German_Word="Katze", German_Article="die", English_Word=None,
                     German_Sentence="Die Katze schläft.", English_Sentence="x"),
        ])
        ds = read_dataset("nouns", skip_invalid=True)
        assert len(ds.core) == 1 and ds.skipped == 1
        katze_id = compute_word_id("noun", "Katze", "die", "")
        assert katze_id in ds.protected
        assert compute_legacy_id("A1.1", "Katze") in ds.protected_aliases

    def test_unknown_column_warns(self, data_dir, caplog):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS + ["Spanisch_Word_Mexican"],
                   [noun_row()])
        import logging
        with caplog.at_level(logging.WARNING, logger="sync"):
            read_dataset("nouns")
        assert any("Spanisch_Word_Mexican" in r.message for r in caplog.records)


class TestContentHash:
    def test_deterministic_and_sensitive(self, data_dir):
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row()])
        h1 = read_dataset("nouns").core[0]["content_hash"]
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS, [noun_row()])
        assert read_dataset("nouns").core[0]["content_hash"] == h1
        make_sheet(data_dir, "nouns.xlsx", NOUN_HEADERS,
                   [noun_row(German_Sentence="Der Hund schläft.")])
        assert read_dataset("nouns").core[0]["content_hash"] != h1
