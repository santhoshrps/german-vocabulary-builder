"""Public-launch gates over the real vocabulary workbooks.

These are deliberately data tests, not fixture-only parser tests: a publishable catalogue must
pass them against the exact spreadsheets that deployment reads. They encode product decisions
confirmed on 20 July 2026 and should remain red while launch content is unfinished.
"""

from functools import lru_cache

import pytest

import dataset


@lru_cache(maxsize=1)
def _preview():
    """A best-effort preview lets independent launch gates report after strict validation fails."""
    return {
        name: dataset.read_dataset(name, skip_invalid=True)
        for name in dataset.TABLES
    }


@pytest.mark.parametrize("table_name", tuple(dataset.TABLES))
def test_publish_catalogue_has_zero_invalid_or_duplicate_rows(table_name):
    """Product purpose: unfinished/ambiguous vocabulary is a launch blocker, never skipped."""
    parsed = dataset.read_dataset(table_name)
    assert parsed.skipped == 0


def test_free_preview_contains_exactly_one_hundred_words():
    """Product purpose: every free learner receives the final fixed 100-word catalogue tier."""
    free = sum(int(row.get("free") or 0) for table in _preview().values() for row in table.core)
    assert free == 100


def test_launch_required_english_translation_package_covers_every_word():
    """Product purpose: the required English package must cover the complete catalogue."""
    language = dataset.REQUIRED_LANGUAGE
    tables = _preview().values()
    total = sum(len(table.core) for table in tables)
    translated = sum(table.coverage.get(language, 0) for table in _preview().values())
    assert translated == total, f"{language} coverage is {translated}/{total}"


def test_every_launch_noun_has_an_article():
    """Product purpose: every noun needs an article; a meaningful plural may not exist."""
    incomplete = [
        row["word"] for row in _preview()["nouns"].core
        if not row.get("article")
    ]
    assert incomplete == [], f"{len(incomplete)} nouns lack an article; sample={incomplete[:20]}"
