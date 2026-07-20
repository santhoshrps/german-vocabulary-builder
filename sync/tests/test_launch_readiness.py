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


@pytest.mark.parametrize("language", ("es-419", "zh"))
def test_launch_base_translation_packages_cover_every_word(language):
    """Product purpose: Spanish and Mandarin must be complete before the public launch."""
    tables = _preview().values()
    total = sum(len(table.core) for table in tables)
    translated = sum(table.coverage.get(language, 0) for table in _preview().values())
    assert translated == total, f"{language} coverage is {translated}/{total}"


def test_every_launch_noun_has_article_and_plural():
    """Product purpose: noun learning/mastery requires both article and plural content."""
    incomplete = [
        row["word"] for row in _preview()["nouns"].core
        if not row.get("article") or not row.get("plural")
    ]
    assert incomplete == [], f"{len(incomplete)} nouns lack article/plural; sample={incomplete[:20]}"
