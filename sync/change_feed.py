"""Build the immutable vocabulary publication/change-feed payload.

This module is deliberately pure: it receives the current physical D1 rows and
the validated target rows produced from the workbooks, then returns one
transaction payload for the write Worker. Network and mutation stay in sync.py.

The language overlay mirrors read-worker/src/data.ts exactly:
requested variant -> base -> English, with a composite hash made from the core
hash and every translation hash in that chain. Keeping this projection here
allows publication metadata and served rows to be validated before D1 changes.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from typing import Any

from registry import LANGUAGES, REQUIRED_LANGUAGE

CANONICAL_TABLES = ("verbs", "nouns", "adverbs_adjectives")
PHYSICAL_TABLES = CANONICAL_TABLES + ("translations", "id_aliases")
SCOPES = ("free", "full")
DATASET_GENERATION = 2
CONTRACT_VERSION = 1

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,256}$")
_TRANSLATION_ID = re.compile(r"^[A-Za-z0-9._-]{1,256}:[A-Za-z0-9-]{1,32}$")


class PublicationError(ValueError):
    """The target cannot be represented by the change-feed contract."""


class PublicationRecoveryRequired(PublicationError):
    """A valid change requires the full manifest/snapshot recovery generation."""


def _by_id(
    table: str,
    rows: Iterable[dict[str, Any]] | Mapping[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    source = rows.values() if isinstance(rows, Mapping) else rows
    for raw in source:
        row = dict(raw)
        row_id = row.get("id")
        valid_id = (
            isinstance(row_id, str)
            and not row_id.startswith("custom-")
            and (
                _TRANSLATION_ID.fullmatch(row_id)
                if table == "translations"
                else _SAFE_ID.fullmatch(row_id)
            )
        )
        if not valid_id:
            raise PublicationError(f"invalid server id {row_id!r}")
        content_hash = row.get("content_hash")
        if not isinstance(content_hash, str) or not _SHA256.fullmatch(content_hash.lower()):
            raise PublicationError(f"{row_id}: invalid content_hash")
        row["content_hash"] = content_hash.lower()
        if row_id in result:
            raise PublicationError(f"duplicate id {row_id!r}")
        result[row_id] = row
    return result


def canonical_physical(
    tables: dict[str, Iterable[dict[str, Any]]],
) -> dict[str, dict[str, dict[str, Any]]]:
    unknown = set(tables) - set(PHYSICAL_TABLES)
    if unknown:
        raise PublicationError(f"unknown physical tables: {sorted(unknown)}")
    result = {
        table: _by_id(table, tables.get(table, []))
        for table in PHYSICAL_TABLES
    }
    aliases: dict[str, str] = {}
    for old_id, row in result["id_aliases"].items():
        new_id = row.get("new_id")
        if not isinstance(new_id, str) or not _SAFE_ID.fullmatch(new_id) or new_id == old_id:
            raise PublicationError(f"invalid identity alias {old_id!r}")
        aliases[old_id] = new_id
    for source in aliases:
        current = source
        visited: set[str] = set()
        for _ in range(4):
            if current in visited:
                raise PublicationError(f"identity alias cycle at {source!r}")
            visited.add(current)
            if current not in aliases:
                break
            current = aliases[current]
        else:
            if current in aliases:
                raise PublicationError(f"identity alias chain exceeds four hops at {source!r}")
    return result


def resolve_chain(code: str) -> list[str]:
    """Same ordered, deduplicated fallback chain as read-worker/languages.ts."""
    current = code if code in LANGUAGES else REQUIRED_LANGUAGE
    result: list[str] = []
    while current and current not in result:
        result.append(current)
        current = LANGUAGES[current].base or ""
    if REQUIRED_LANGUAGE not in result:
        result.append(REQUIRED_LANGUAGE)
    return result


def _xor_fingerprint(rows: dict[str, dict[str, dict[str, Any]]]) -> str:
    accumulator = bytearray(32)
    for table in CANONICAL_TABLES:
        for row_id, row in rows[table].items():
            contribution = hashlib.sha256(
                f"{table}\0{row_id}\0{row['content_hash']}".encode("utf-8")
            ).digest()
            for index, value in enumerate(contribution):
                accumulator[index] ^= value
    return "xor256-v1:" + bytes(accumulator).hex()


def _counts(rows: dict[str, dict[str, dict[str, Any]]]) -> dict[str, int]:
    return {
        "verbs": len(rows["verbs"]),
        "nouns": len(rows["nouns"]),
        "adverbs_adjectives": len(rows["adverbs_adjectives"]),
    }


def _translation_value(
    translations: dict[tuple[str, str], dict[str, Any]],
    word_id: str,
    chain: list[str],
    field: str,
) -> Any:
    for language in chain:
        row = translations.get((word_id, language))
        if row is not None and row.get(field) is not None:
            return row[field]
    return None


def _translation_index(
    physical: dict[str, dict[str, dict[str, Any]]],
) -> dict[tuple[str, str], dict[str, Any]]:
    translations: dict[tuple[str, str], dict[str, Any]] = {}
    for row in physical["translations"].values():
        word_id = row.get("word_id")
        language = row.get("lang")
        if not isinstance(word_id, str) or not isinstance(language, str):
            raise PublicationError(f"translation {row.get('id')!r} lacks word_id/lang")
        key = (word_id, language)
        if key in translations:
            raise PublicationError(f"duplicate translation {word_id}:{language}")
        translations[key] = row
    return translations


def _build_view(
    physical: dict[str, dict[str, dict[str, Any]]],
    translations: dict[tuple[str, str], dict[str, Any]],
    *,
    scope: str,
    language: str,
    compact: bool = False,
) -> dict[str, Any]:
    chain = resolve_chain(language)
    tables: dict[str, dict[str, dict[str, Any]]] = {
        table: {} for table in CANONICAL_TABLES
    }
    global_ids: set[str] = set()
    for table in CANONICAL_TABLES:
        for row_id, core in physical[table].items():
            if scope == "free" and int(core.get("free") or 0) != 1:
                continue
            if row_id in global_ids:
                raise PublicationError(
                    f"canonical id {row_id!r} appears in more than one table"
                )
            global_ids.add(row_id)

            hashes = [str(core["content_hash"])]
            for chain_language in chain:
                translation = translations.get((row_id, chain_language))
                hashes.append(str(translation["content_hash"]) if translation else "")
            wire_hash = hashlib.sha256(
                ":".join(hashes).encode("utf-8")
            ).hexdigest()
            if compact:
                tables[table][row_id] = {
                    "content_hash": wire_hash,
                    "type": core.get("type"),
                }
                continue

            served = {
                key: value
                for key, value in core.items()
                if key != "updated_at"
            }
            # The wire hash is one canonical SHA-256, not the internal
            # colon-joined component descriptor. The read Worker applies
            # the same final hash in every legacy/full endpoint.
            served["content_hash"] = wire_hash
            # The app's v1-compatible wire shape names the selected source
            # language fields `english`, regardless of actual language.
            served["english"] = _translation_value(
                translations, row_id, chain, "word"
            )
            served["english_sentence"] = _translation_value(
                translations, row_id, chain, "sentence"
            )
            served["translation_article"] = _translation_value(
                translations, row_id, chain, "article"
            )
            served["translation_article_plural"] = _translation_value(
                translations, row_id, chain, "article_plural"
            )
            served["translation_plural"] = _translation_value(
                translations, row_id, chain, "plural"
            )
            tables[table][row_id] = served
    return {
        "tables": tables,
        "counts": _counts(tables),
        "fingerprint": _xor_fingerprint(tables),
    }


def build_views(
    physical: dict[str, dict[str, dict[str, Any]]],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Build every scope/language served view and its exact wire rows.

    Publication itself uses one view at a time below to keep 50k-scale peak
    memory bounded; this all-view helper remains useful for compact fixtures.
    """
    translations = _translation_index(physical)
    views: dict[tuple[str, str], dict[str, Any]] = {}
    for language in LANGUAGES:
        for scope in SCOPES:
            views[(scope, language)] = _build_view(
                physical,
                translations,
                scope=scope,
                language=language,
            )
    return views


def base_version(physical: dict[str, dict[str, dict[str, Any]]]) -> str:
    """Deterministic opaque identity for the complete physical target."""
    digest = hashlib.sha256()
    for table in PHYSICAL_TABLES:
        for row_id in sorted(physical[table]):
            row = physical[table][row_id]
            digest.update(table.encode())
            digest.update(b"\0")
            digest.update(row_id.encode())
            digest.update(b"\0")
            digest.update(str(row["content_hash"]).encode())
            digest.update(b"\n")
    return digest.hexdigest()


def physical_delta(
    current: dict[str, dict[str, dict[str, Any]]],
    target: dict[str, dict[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table in PHYSICAL_TABLES:
        before = current[table]
        after = target[table]
        upsert = [
            after[row_id]
            for row_id in sorted(after)
            if row_id not in before
            or before[row_id]["content_hash"] != after[row_id]["content_hash"]
        ]
        delete = sorted(set(before) - set(after))
        result.append({"table": table, "upsert": upsert, "delete": delete})
    return result


def _flat_changed(
    before: dict[str, Any],
    after: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    old_owner = {
        row_id: table
        for table in CANONICAL_TABLES
        for row_id in before["tables"][table]
    }
    new_owner = {
        row_id: table
        for table in CANONICAL_TABLES
        for row_id in after["tables"][table]
    }
    moved = {
        row_id
        for row_id in set(old_owner) & set(new_owner)
        if old_owner[row_id] != new_owner[row_id]
    }
    if moved:
        raise PublicationRecoveryRequired(
            "cross-table identity movement requires full recovery: "
            + ", ".join(sorted(moved)[:5])
        )
    changed: list[dict[str, Any]] = []
    deleted: list[dict[str, str]] = []
    for table in CANONICAL_TABLES:
        old_rows = before["tables"][table]
        new_rows = after["tables"][table]
        for row_id in sorted(new_rows):
            row = new_rows[row_id]
            if row_id not in old_rows or (
                old_rows[row_id]["content_hash"] != row["content_hash"]
            ):
                changed.append(
                    {
                        "table": table,
                        "id": row_id,
                        "content_hash": row["content_hash"],
                        "previous_content_hash": (
                            old_rows[row_id]["content_hash"]
                            if row_id in old_rows
                            else None
                        ),
                        "row": row,
                    }
                )
        for row_id in sorted(set(old_rows) - set(new_rows)):
            deleted.append(
                {
                    "table": table,
                    "id": row_id,
                    "content_hash": old_rows[row_id]["content_hash"],
                }
            )
    return changed, deleted


def _view_aliases(
    target: dict[str, dict[str, dict[str, Any]]],
    after_view: dict[str, Any],
    deleted: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Only rename aliases relevant to this delta belong in the feed.

    The large v1->v2 migration map is still served by /aliases for full recovery;
    emitting it on every routine update would be unbounded. A feed alias is valid
    only when its old id was deleted by this publication and its new id exists in
    this target scope.
    """
    deleted_ids = {entry["id"] for entry in deleted}
    target_ids = {
        row_id
        for table in CANONICAL_TABLES
        for row_id in after_view["tables"][table]
    }
    aliases: list[dict[str, str]] = []
    for old_id, row in sorted(target["id_aliases"].items()):
        new_id = row.get("new_id")
        if old_id in deleted_ids and isinstance(new_id, str) and new_id in target_ids:
            aliases.append({"old_id": old_id, "new_id": new_id})
    return aliases


def _type_changes(
    before_view: dict[str, Any],
    after_view: dict[str, Any],
    changed: list[dict[str, Any]],
) -> list[dict[str, str]]:
    changed_ids = {
        entry["id"]
        for entry in changed
        if entry["table"] == "adverbs_adjectives"
    }
    old_rows = before_view["tables"]["adverbs_adjectives"]
    new_rows = after_view["tables"]["adverbs_adjectives"]
    result: list[dict[str, str]] = []
    for row_id in sorted(changed_ids & set(old_rows) & set(new_rows)):
        old_type = old_rows[row_id].get("type")
        new_type = new_rows[row_id].get("type")
        if {old_type, new_type} == {"adjective", "adverb"}:
            result.append(
                {
                    "id": row_id,
                    "from_table": "adverbs_adjectives",
                    "from_type": str(old_type),
                    "to_table": "adverbs_adjectives",
                    "to_type": str(new_type),
                }
            )
    return result


def publication_payload(
    current: dict[str, dict[str, dict[str, Any]]],
    target: dict[str, dict[str, dict[str, Any]]],
    *,
    current_cursor: dict[str, Any] | None,
    generation: int = DATASET_GENERATION,
) -> dict[str, Any]:
    current_translations = _translation_index(current)
    target_translations = _translation_index(target)
    physical = physical_delta(current, target)
    target_base_version = base_version(target)

    views: list[dict[str, Any]] = []
    for language in LANGUAGES:
        for scope in SCOPES:
            before = _build_view(
                current,
                current_translations,
                scope=scope,
                language=language,
                compact=True,
            )
            after = _build_view(
                target,
                target_translations,
                scope=scope,
                language=language,
            )
            changed, deleted = _flat_changed(before, after)
            views.append(
                {
                    "scope": scope,
                    "language": language,
                    "from_fingerprint": before["fingerprint"],
                    "target_fingerprint": after["fingerprint"],
                    "from_counts": before["counts"],
                    "target_counts": after["counts"],
                    "changed": changed,
                    "deleted": deleted,
                    "aliases": _view_aliases(target, after, deleted),
                    "type_changes": _type_changes(before, after, changed),
                }
            )

    return {
        "contract_version": CONTRACT_VERSION,
        "from_base_version": (
            current_cursor.get("base_version") if current_cursor else None
        ),
        "target_base_version": target_base_version,
        "dataset_generation": generation,
        "physical": physical,
        "views": views,
    }


def baseline_payload(
    physical: dict[str, dict[str, dict[str, Any]]],
    *,
    generation: int,
) -> dict[str, Any]:
    translations = _translation_index(physical)
    view_metadata: list[dict[str, Any]] = []
    for language in LANGUAGES:
        for scope in SCOPES:
            view = _build_view(
                physical,
                translations,
                scope=scope,
                language=language,
                compact=True,
            )
            view_metadata.append(
                {
                    "scope": scope,
                    "language": language,
                    "target_fingerprint": view["fingerprint"],
                    "target_counts": view["counts"],
                }
            )
    return {
        "contract_version": CONTRACT_VERSION,
        "target_base_version": base_version(physical),
        "dataset_generation": generation,
        "views": view_metadata,
    }


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
