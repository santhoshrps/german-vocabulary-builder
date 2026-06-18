import hashlib
import hmac
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import openpyxl
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
API_KEY = os.environ["API_KEY"]
DATA_DIR = Path(__file__).parent.parent / "data"

# Table name → (xlsx filename, Excel column headers in order)
TABLE_CONFIG: dict[str, tuple[str, list[str]]] = {
    "verbs": (
        "verbs.xlsx",
        [
            "Level", "Capital", "Type", "Word", "English",
            "German_Sentence", "English_Sentence",
            "ich", "du", "er_sie_es", "wir", "ihr", "sie_Sie",
            "past_participle", "simple_past",
        ],
    ),
    "nouns": (
        "nouns.xlsx",
        [
            "Level", "Capital", "Type", "Article", "Word", "Plural", "Image",
            "English", "German_Sentence", "English_Sentence",
        ],
    ),
    "adverbs_adjectives": (
        "adverbs_adjectives.xlsx",
        [
            "Level", "Capital", "Type", "Word", "English",
            "German_Sentence", "English_Sentence", "Comparative", "Superlative",
        ],
    ),
}

# Excel header → DB column name for headers that don't simply .lower() correctly
HEADER_TO_DB: dict[str, str] = {
    "sie_Sie": "sie_sie",
    "German_Sentence": "german_sentence",
    "English_Sentence": "english_sentence",
    "past_participle": "past_participle",
    "simple_past": "simple_past",
    "Comparative": "comparative",
    "Superlative": "superlative",
}

UPSERT_CHUNK_SIZE = 200


def _db_col(header: str) -> str:
    return HEADER_TO_DB.get(header, header.lower())


def compute_id(level: str, word: str) -> str:
    raw = f"{level.lower()}|{word.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def compute_content_hash(row: dict[str, Any]) -> str:
    # Sort keys alphabetically for a stable, reproducible order
    concatenated = "|".join(
        str(row[k]) if row[k] is not None else ""
        for k in sorted(row.keys())
        if k not in ("id", "content_hash")
    )
    return hashlib.sha256(concatenated.encode()).hexdigest()


def read_excel(table: str) -> list[dict[str, Any]]:
    filename, headers = TABLE_CONFIG[table]
    path = DATA_DIR / filename
    if not path.exists():
        print(f"  [WARNING] {path} not found — skipping table '{table}'")
        return []

    level_idx = headers.index("Level")
    word_idx = headers.index("Word")

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for i, raw_row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            # Validate header row to catch misaligned files early
            actual = [str(c).strip() if c is not None else "" for c in raw_row[: len(headers)]]
            if actual != headers:
                print(
                    f"  [WARNING] '{filename}' header mismatch.\n"
                    f"    Expected: {headers}\n"
                    f"    Got:      {actual}"
                )
            continue

        level_val = raw_row[level_idx] if level_idx < len(raw_row) else None
        word_val = raw_row[word_idx] if word_idx < len(raw_row) else None

        if not level_val or not word_val:
            continue  # skip blank/trailing rows

        record: dict[str, Any] = {}
        for j, header in enumerate(headers):
            db_col = _db_col(header)
            value = raw_row[j] if j < len(raw_row) else None
            if isinstance(value, str):
                value = value.strip() or None
            record[db_col] = value

        # Normalise Image boolean for nouns
        if table == "nouns":
            record["image"] = 1 if record.get("image") else 0

        row_id = compute_id(str(level_val), str(word_val))

        if row_id in seen_ids:
            print(
                f"  [WARNING] Duplicate row (same level+word after lowercasing): "
                f"level={level_val!r} word={word_val!r} — keeping first occurrence"
            )
            continue

        seen_ids.add(row_id)
        record["id"] = row_id
        record["content_hash"] = compute_content_hash(record)
        rows.append(record)

    wb.close()
    return rows


def get_db_state(client: httpx.Client, table: str) -> dict[str, str]:
    response = client.get(f"{WORKER_URL}/state/{table}")
    response.raise_for_status()
    return response.json()


def post_sync(
    client: httpx.Client,
    table: str,
    upsert: list[dict[str, Any]],
    delete: list[str],
) -> dict[str, int]:
    total_upserted = 0
    total_deleted = 0

    # Chunk upserts to stay within D1 batch limits; include deletes on the first chunk only
    chunks = [upsert[i : i + UPSERT_CHUNK_SIZE] for i in range(0, max(len(upsert), 1), UPSERT_CHUNK_SIZE)]
    for chunk_idx, chunk in enumerate(chunks):
        chunk_delete = delete if chunk_idx == 0 else []
        response = client.post(
            f"{WORKER_URL}/sync/{table}",
            json={"upsert": chunk, "delete": chunk_delete},
            timeout=60.0,
        )
        response.raise_for_status()
        result = response.json()
        total_upserted += result.get("upserted", 0)
        total_deleted += result.get("deleted", 0)

    return {"upserted": total_upserted, "deleted": total_deleted}


def compute_diff(
    excel_rows: list[dict[str, Any]],
    db_state: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str]]:
    excel_by_id = {row["id"]: row for row in excel_rows}

    to_upsert = [
        row
        for row_id, row in excel_by_id.items()
        if row_id not in db_state or db_state[row_id] != row["content_hash"]
    ]
    to_delete = [row_id for row_id in db_state if row_id not in excel_by_id]

    return to_upsert, to_delete


def sync_table(client: httpx.Client, table: str) -> None:
    print(f"\n[{table}]")

    print("  Reading Excel...")
    excel_rows = read_excel(table)
    print(f"  {len(excel_rows)} rows in Excel.")

    print("  Fetching DB state...")
    db_state = get_db_state(client, table)
    print(f"  {len(db_state)} rows in DB.")

    to_upsert, to_delete = compute_diff(excel_rows, db_state)
    print(f"  Diff: {len(to_upsert)} to upsert, {len(to_delete)} to delete.")

    if not to_upsert and not to_delete:
        print("  Already in sync.")
        return

    result = post_sync(client, table, to_upsert, to_delete)
    print(f"  Done: upserted={result['upserted']}, deleted={result['deleted']}")


def _sign_request(request: httpx.Request) -> None:
    """Attach HMAC-SHA256 signature headers to every outgoing request.

    Canonical string: METHOD\nURL\nTIMESTAMP\nSHA256(body_bytes)
    The raw API_KEY never travels over the wire — only the signed digest does.
    The Worker rejects signatures with a timestamp older than 5 minutes.
    """
    timestamp = str(int(time.time()))
    body_hash = hashlib.sha256(request.content).hexdigest()
    canonical = f"{request.method}\n{request.url}\n{timestamp}\n{body_hash}"
    signature = hmac.new(API_KEY.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    request.headers["X-Timestamp"] = timestamp
    request.headers["X-Signature"] = signature


def main() -> None:
    missing = [k for k in ("WORKER_URL", "API_KEY") if not os.environ.get(k)]
    if missing:
        print(f"Error: missing environment variables: {', '.join(missing)}")
        print("Copy sync/.env.example to sync/.env and fill in the values.")
        sys.exit(1)

    with httpx.Client(event_hooks={"request": [_sign_request]}) as client:
        for table in TABLE_CONFIG:
            sync_table(client, table)

    print("\nSync complete.")


if __name__ == "__main__":
    main()
