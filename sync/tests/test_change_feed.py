"""Immutable vocabulary publication/change-feed projection tests."""

import hashlib
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import change_feed
import sync as sync_cli


def sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def noun(word_id: str, *, free: int = 0, revision: str = "1") -> dict:
    return {
        "id": word_id,
        "content_hash": sha(f"core:{word_id}:{revision}"),
        "free": free,
        "level": "A1",
        "capital": None,
        "type": "noun",
        "article": "der",
        "word": word_id.title(),
        "plural": f"{word_id.title()}e",
        "sense": None,
        "image": 0,
        "german_sentence": f"Der {word_id} ist hier.",
    }


def translation(
    word_id: str,
    language: str,
    *,
    word: str,
    revision: str = "1",
) -> dict:
    return {
        "id": f"{word_id}:{language}",
        "content_hash": sha(f"translation:{word_id}:{language}:{revision}"),
        "word_id": word_id,
        "lang": language,
        "word": word,
        "sentence": f"{word} sentence",
        "article": None,
        "article_plural": None,
        "plural": None,
    }


def physical(*, nouns=(), translations=(), aliases=()):
    return change_feed.canonical_physical(
        {
            "verbs": [],
            "nouns": list(nouns),
            "adverbs_adjectives": [],
            "translations": list(translations),
            "id_aliases": list(aliases),
        }
    )


def test_wire_hash_and_fingerprint_match_contract():
    source = physical(
        nouns=[noun("hund", free=1)],
        translations=[translation("hund", "en", word="dog")],
    )
    views = change_feed.build_views(source)
    row = views[("free", "en")]["tables"]["nouns"]["hund"]
    descriptor = (
        f"{source['nouns']['hund']['content_hash']}:"
        f"{source['translations']['hund:en']['content_hash']}"
    )
    assert row["content_hash"] == hashlib.sha256(descriptor.encode()).hexdigest()
    assert views[("free", "en")]["fingerprint"].startswith("xor256-v1:")
    assert views[("free", "en")]["counts"] == {
        "verbs": 0,
        "nouns": 1,
        "adverbs_adjectives": 0,
    }


def test_variant_translation_changes_only_its_fallback_view():
    current = physical(
        nouns=[noun("hund", free=1)],
        translations=[translation("hund", "en", word="dog")],
    )
    target = physical(
        nouns=[noun("hund", free=1)],
        translations=[
            translation("hund", "en", word="dog"),
            translation("hund", "en-US", word="dog", revision="us-1"),
        ],
    )
    payload = change_feed.publication_payload(
        current,
        target,
        current_cursor={
            "base_version": change_feed.base_version(current),
            "dataset_generation": 2,
        },
    )
    views = {(v["scope"], v["language"]): v for v in payload["views"]}
    assert len(views[("free", "en-US")]["changed"]) == 1
    assert len(views[("full", "en-US")]["changed"]) == 1
    assert views[("free", "en")]["changed"] == []
    assert views[("full", "es-MX")]["changed"] == []


def test_full_only_update_never_enters_free_change_feed():
    current = physical(
        nouns=[noun("hund", free=0, revision="1")],
        translations=[translation("hund", "en", word="dog")],
    )
    target = physical(
        nouns=[noun("hund", free=0, revision="2")],
        translations=[translation("hund", "en", word="dog")],
    )
    payload = change_feed.publication_payload(
        current,
        target,
        current_cursor={
            "base_version": change_feed.base_version(current),
            "dataset_generation": 2,
        },
    )
    for view in payload["views"]:
        if view["scope"] == "free":
            assert view["changed"] == []
            assert view["deleted"] == []
        else:
            assert [entry["id"] for entry in view["changed"]] == ["hund"]


def test_delete_readd_and_type_inputs_are_deterministic():
    current = physical(
        nouns=[noun("hund"), noun("katze")],
        translations=[
            translation("hund", "en", word="dog"),
            translation("katze", "en", word="cat"),
        ],
    )
    target = physical(
        nouns=[noun("hund", revision="2")],
        translations=[translation("hund", "en", word="dog")],
    )
    first = change_feed.publication_payload(
        current, target, current_cursor={"base_version": "a" * 64}
    )
    second = change_feed.publication_payload(
        current, target, current_cursor={"base_version": "a" * 64}
    )
    assert change_feed.compact_json(first) == change_feed.compact_json(second)
    full_en = next(
        v for v in first["views"]
        if v["scope"] == "full" and v["language"] == "en"
    )
    assert [row["id"] for row in full_en["changed"]] == ["hund"]
    assert full_en["deleted"] == [{
        "table": "nouns",
        "id": "katze",
        "content_hash": (
            change_feed.build_views(current)[("full", "en")]
            ["tables"]["nouns"]["katze"]["content_hash"]
        ),
    }]


def test_skipped_and_partial_publish_rows_are_preserved_from_authoritative_state():
    current = physical(
        nouns=[noun("hund"), noun("katze")],
        translations=[
            translation("hund", "en", word="dog"),
            translation("katze", "en", word="cat"),
        ],
    )
    state = {
        "cursor": None,
        "tables": {
            table: list(rows.values())
            for table, rows in current.items()
        },
    }
    changed_hund = noun("hund", revision="2")
    changed_translation = translation("hund", "en", word="hound", revision="2")
    plan = [
        ("nouns", [changed_hund], 1, {"katze"}),
        # Partial-table publication overlays translations and cannot delete
        # untranslated rows belonging to the unread word tables.
        ("translations", [changed_translation], 0, {"*"}),
    ]
    _, target = sync_cli._target_physical_rows(state, plan)
    assert set(target["nouns"]) == {"hund", "katze"}
    assert target["nouns"]["katze"] == current["nouns"]["katze"]
    assert set(target["translations"]) == {"hund:en", "katze:en"}
    assert target["translations"]["katze:en"] == current["translations"]["katze:en"]


@pytest.mark.skipif(
    os.environ.get("RUN_VOCABULARY_DELTA_50K_TEST") != "1",
    reason="one-time 50k publication projection test",
)
def test_one_word_update_at_50k_scale_has_one_changed_catalogue_id():
    nouns = [noun(f"word-{index:05d}") for index in range(50_000)]
    translations = [
        translation(f"word-{index:05d}", "en", word=f"word {index}")
        for index in range(50_000)
    ]
    current = physical(nouns=nouns, translations=translations)
    target_nouns = list(nouns)
    target_nouns[24_321] = noun("word-24321", revision="2")
    target = physical(nouns=target_nouns, translations=translations)
    payload = change_feed.publication_payload(
        current,
        target,
        current_cursor={
            "base_version": change_feed.base_version(current),
            "dataset_generation": 2,
        },
    )
    physical_mutations = sum(
        len(group["upsert"]) + len(group["delete"])
        for group in payload["physical"]
    )
    assert physical_mutations == 1
    for view in payload["views"]:
        if view["scope"] == "free":
            assert view["changed"] == []
        else:
            assert [entry["id"] for entry in view["changed"]] == ["word-24321"]
