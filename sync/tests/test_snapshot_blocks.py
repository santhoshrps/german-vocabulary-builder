"""Immutable compressed full-install snapshot tests."""

import hashlib
import json
import os
import sys
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import change_feed
import snapshot_blocks
import sync as sync_cli


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def noun(index: int, *, free: int = 1) -> dict:
    word_id = f"word-{index:05d}"
    return {
        "id": word_id,
        "content_hash": sha(f"noun:{word_id}"),
        "free": free,
        "level": "A1",
        "capital": None,
        "type": "noun",
        "article": "das",
        "word": f"Wort {index}",
        "plural": f"Wörter {index}",
        "sense": None,
        "image": 0,
        "german_sentence": f"Das ist Wort {index}.",
    }


def translation(index: int) -> dict:
    word_id = f"word-{index:05d}"
    return {
        "id": f"{word_id}:en",
        "content_hash": sha(f"translation:{word_id}"),
        "word_id": word_id,
        "lang": "en",
        "word": f"word {index}",
        "sentence": f"This is word {index}.",
        "article": None,
        "article_plural": None,
        "plural": None,
    }


def physical(count: int) -> dict:
    return change_feed.canonical_physical({
        "verbs": [],
        "nouns": [noun(index) for index in range(count)],
        "adverbs_adjectives": [],
        "translations": [translation(index) for index in range(count)],
        "id_aliases": [],
    })


def test_snapshot_is_deterministic_bounded_and_independently_verifiable():
    source = physical(1_501)
    first = snapshot_blocks.build_snapshot(
        source, generation=2, language="en", scope="full")
    second = snapshot_blocks.build_snapshot(
        source, generation=2, language="en", scope="full")

    assert first.manifest == second.manifest
    assert [block.payload for block in first.blocks] == [
        block.payload for block in second.blocks
    ]
    assert [block.row_count for block in first.blocks] == [750, 750, 1]
    assert all(block.compressed_bytes == len(block.payload) for block in first.blocks)
    assert all(block.row_count <= 1_000 for block in first.blocks)

    observed_ids = []
    for block in first.blocks:
        assert hashlib.sha256(block.payload).hexdigest() == block.checksum
        raw = zlib.decompress(block.payload)
        assert len(raw) == block.uncompressed_bytes
        rows = [
            json.loads(line)
            for line in raw.decode("utf-8").splitlines()
        ]
        assert len(rows) == block.row_count
        observed_ids.extend(row["id"] for row in rows)
    assert observed_ids == sorted(observed_ids)
    assert len(set(observed_ids)) == 1_501

    unsigned = {
        key: value for key, value in first.manifest.items()
        if key != "manifest_checksum"
    }
    canonical = json.dumps(
        unsigned, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    assert hashlib.sha256(canonical).hexdigest() == (
        first.manifest["manifest_checksum"]
    )


def test_all_language_scope_views_are_frozen_without_mixing_identity():
    snapshots = snapshot_blocks.build_all_snapshots(
        physical(501), generation=2)
    assert len(snapshots) == (
        len(change_feed.LANGUAGES) * len(change_feed.SCOPES)
    )
    identities = {
        (
            item.manifest["language"],
            item.manifest["scope"],
            item.manifest["snapshot_id"],
        )
        for item in snapshots
    }
    assert len(identities) == len(snapshots)
    assert all(item.manifest["total_count"] == 501 for item in snapshots)


def test_invalid_partition_and_empty_entitlement_fail_closed():
    source = physical(1)
    with pytest.raises(snapshot_blocks.SnapshotBlockError):
        snapshot_blocks.build_snapshot(
            source, generation=2, language="en", scope="full",
            rows_per_block=499)
    with pytest.raises(snapshot_blocks.SnapshotBlockError):
        snapshot_blocks.build_snapshot(
            source, generation=2, language="en", scope="full",
            rows_per_block=1_001)
    empty = change_feed.canonical_physical({
        table: [] for table in change_feed.PHYSICAL_TABLES
    })
    with pytest.raises(snapshot_blocks.SnapshotBlockError):
        snapshot_blocks.build_snapshot(
            empty, generation=2, language="en", scope="full")


def test_snapshot_refreshes_before_change_feed_retention_can_pass_it():
    complete = len(change_feed.LANGUAGES) * len(change_feed.SCOPES)
    assert not sync_cli._snapshot_refresh_required({
        "snapshot_views_available": complete,
        "oldest_snapshot_sequence": 5,
        "cursor": {"sequence": 204},
    })
    assert sync_cli._snapshot_refresh_required({
        "snapshot_views_available": complete,
        "oldest_snapshot_sequence": 5,
        "cursor": {"sequence": 205},
    })
    assert sync_cli._snapshot_refresh_required({
        "snapshot_views_available": complete - 1,
        "oldest_snapshot_sequence": 205,
        "cursor": {"sequence": 205},
    })
    # Missing age means an older worker/incomplete schema: fail safe and refresh.
    assert sync_cli._snapshot_refresh_required({
        "snapshot_views_available": complete,
        "cursor": {"sequence": 205},
    })


@pytest.mark.skipif(
    os.environ.get("RUN_VOCABULARY_SNAPSHOT_50K_TEST") != "1",
    reason="one-time 50k immutable-block scale test",
)
def test_50k_snapshot_has_bounded_blocks_and_exact_global_counts():
    result = snapshot_blocks.build_snapshot(
        physical(50_000), generation=2, language="en", scope="full")
    assert result.manifest["total_count"] == 50_000
    assert result.manifest["table_counts"] == {
        "verbs": 0,
        "nouns": 50_000,
        "adverbs_adjectives": 0,
    }
    assert len(result.blocks) == 67
    assert max(block.row_count for block in result.blocks) == 750
    assert sum(block.row_count for block in result.blocks) == 50_000
    assert sum(block.compressed_bytes for block in result.blocks) == (
        result.manifest["total_compressed_bytes"]
    )
