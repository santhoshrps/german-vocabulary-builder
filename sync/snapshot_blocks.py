"""Build immutable, compressed full-install vocabulary snapshots.

The phone never constructs these blocks. Publication freezes one fully validated
language/scope view, partitions each physical word table into deterministic
750-row blocks, compresses every block independently, and uploads the blocks
before the write Worker atomically makes their manifest visible.

Routine delta publication does not rebuild snapshots one-for-one. A device may
therefore install the latest retained full snapshot and immediately catch up
through the normal immutable change feed. The publisher refreshes the complete
snapshot set only at a bounded age inside feed retention. This keeps ordinary
one-word editorial updates O(1) while full installation remains bounded and
resumable.
"""

from __future__ import annotations

import base64
import hashlib
import json
import zlib
from dataclasses import dataclass
from collections.abc import Iterator
from typing import Any

import change_feed

CONTRACT_VERSION = 1
SCHEMA_VERSION = 2
ROWS_PER_BLOCK = 750
COMPRESSION = "zlib"


class SnapshotBlockError(ValueError):
    """A target view cannot be represented by the block snapshot contract."""


@dataclass(frozen=True)
class SnapshotBlock:
    snapshot_id: str
    block_id: str
    table: str
    index: int
    row_count: int
    compressed_bytes: int
    uncompressed_bytes: int
    checksum: str
    payload: bytes

    def metadata(self) -> dict[str, Any]:
        return {
            "id": self.block_id,
            "table": self.table,
            "index": self.index,
            "row_count": self.row_count,
            "compressed_bytes": self.compressed_bytes,
            "uncompressed_bytes": self.uncompressed_bytes,
            "checksum": self.checksum,
        }

    def upload_payload(self) -> dict[str, Any]:
        return {
            "contract_version": CONTRACT_VERSION,
            "snapshot_id": self.snapshot_id,
            **self.metadata(),
            "payload_base64": base64.b64encode(self.payload).decode("ascii"),
        }


@dataclass(frozen=True)
class SnapshotSet:
    manifest: dict[str, Any]
    blocks: tuple[SnapshotBlock, ...]


def _compact(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return hashlib.sha256(_compact(unsigned)).hexdigest()


def _snapshot_id(
    *,
    base_version: str,
    generation: int,
    language: str,
    scope: str,
    fingerprint: str,
) -> str:
    material = (
        f"snapshot-v{CONTRACT_VERSION}\0schema-{SCHEMA_VERSION}\0"
        f"{generation}\0{base_version}\0{language}\0{scope}\0{fingerprint}"
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def build_snapshot(
    physical: dict[str, dict[str, dict[str, Any]]],
    *,
    generation: int,
    language: str,
    scope: str,
    rows_per_block: int = ROWS_PER_BLOCK,
    _canonicalized: bool = False,
) -> SnapshotSet:
    """Build one deterministic language/scope snapshot.

    Blocks contain newline-delimited served row JSON without table wrappers; the
    manifest's table identity is authoritative. Sorting by stable server ID makes
    replay, checksums and test fixtures deterministic.
    """
    if not isinstance(generation, int) or generation <= 0:
        raise SnapshotBlockError("generation must be positive")
    if language not in change_feed.LANGUAGES:
        raise SnapshotBlockError(f"unsupported language {language!r}")
    if scope not in change_feed.SCOPES:
        raise SnapshotBlockError(f"unsupported scope {scope!r}")
    if rows_per_block < 500 or rows_per_block > 1_000:
        raise SnapshotBlockError("rows_per_block must be between 500 and 1,000")

    canonical = physical if _canonicalized else change_feed.canonical_physical(physical)
    translations = change_feed._translation_index(canonical)
    view = change_feed._build_view(
        canonical,
        translations,
        scope=scope,
        language=language,
    )
    target_base_version = change_feed.base_version(canonical)
    snapshot_id = _snapshot_id(
        base_version=target_base_version,
        generation=generation,
        language=language,
        scope=scope,
        fingerprint=view["fingerprint"],
    )

    blocks: list[SnapshotBlock] = []
    table_block_index = {table: 0 for table in change_feed.CANONICAL_TABLES}
    for table in change_feed.CANONICAL_TABLES:
        rows = view["tables"][table]
        ordered = [rows[row_id] for row_id in sorted(rows)]
        for offset in range(0, len(ordered), rows_per_block):
            chunk = ordered[offset : offset + rows_per_block]
            # A final newline makes the format stream-friendly and unambiguous.
            raw = b"".join(_compact(row) + b"\n" for row in chunk)
            compressed = zlib.compress(raw, level=6)
            checksum = hashlib.sha256(compressed).hexdigest()
            index = table_block_index[table]
            identity = hashlib.sha256(
                f"{snapshot_id}\0{table}\0{index}\0{checksum}".encode("utf-8")
            ).hexdigest()
            blocks.append(SnapshotBlock(
                snapshot_id=snapshot_id,
                block_id=identity,
                table=table,
                index=index,
                row_count=len(chunk),
                compressed_bytes=len(compressed),
                uncompressed_bytes=len(raw),
                checksum=checksum,
                payload=compressed,
            ))
            table_block_index[table] += 1

    if not blocks:
        raise SnapshotBlockError("an empty entitled catalogue cannot be published")

    manifest: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "snapshot_id": snapshot_id,
        "dataset_generation": generation,
        "base_version": target_base_version,
        "version": f"{target_base_version}:{scope}",
        "language": language,
        "scope": scope,
        "schema_version": SCHEMA_VERSION,
        "compression": COMPRESSION,
        "total_count": sum(view["counts"].values()),
        "table_counts": view["counts"],
        "global_fingerprint": view["fingerprint"],
        "block_count": len(blocks),
        "total_compressed_bytes": sum(block.compressed_bytes for block in blocks),
        "total_uncompressed_bytes": sum(block.uncompressed_bytes for block in blocks),
        "blocks": [block.metadata() for block in blocks],
    }
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    return SnapshotSet(manifest=manifest, blocks=tuple(blocks))


def build_all_snapshots(
    physical: dict[str, dict[str, dict[str, Any]]],
    *,
    generation: int,
    rows_per_block: int = ROWS_PER_BLOCK,
) -> tuple[SnapshotSet, ...]:
    canonical = change_feed.canonical_physical(physical)
    return tuple(
        build_snapshot(
            canonical,
            generation=generation,
            language=language,
            scope=scope,
            rows_per_block=rows_per_block,
            _canonicalized=True,
        )
        for language in change_feed.LANGUAGES
        for scope in change_feed.SCOPES
    )


def iter_all_snapshots(
    physical: dict[str, dict[str, dict[str, Any]]],
    *,
    generation: int,
    rows_per_block: int = ROWS_PER_BLOCK,
) -> Iterator[SnapshotSet]:
    """Yield one view at a time so publication never retains all compressed worlds."""
    canonical = change_feed.canonical_physical(physical)
    for language in change_feed.LANGUAGES:
        for scope in change_feed.SCOPES:
            yield build_snapshot(
                canonical,
                generation=generation,
                language=language,
                scope=scope,
                rows_per_block=rows_per_block,
                _canonicalized=True,
            )
