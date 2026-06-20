import argparse
import hashlib
import hmac
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import openpyxl
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("sync")

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
API_KEY = os.environ.get("API_KEY", "")
DATA_DIR = Path(__file__).parent.parent / "data"

TABLE_CONFIG: dict[str, tuple[str, list[str]]] = {
    "verbs": (
        "verbs.xlsx",
        [
            "Level", "Capital", "Type", "Word", "English",
            "German_Sentence", "English_Sentence",
            "ich", "du", "er_sie_es", "wir", "ihr", "sie_Sie",
            "past_participle", "simple_past", "Free",
        ],
    ),
    "nouns": (
        "nouns.xlsx",
        [
            "Level", "Capital", "Type", "Article", "Word", "Plural", "Image",
            "English", "German_Sentence", "English_Sentence", "Free",
        ],
    ),
    "adverbs_adjectives": (
        "adverbs_adjectives.xlsx",
        [
            "Level", "Capital", "Type", "Word", "English",
            "German_Sentence", "English_Sentence", "Comparative", "Superlative", "Free",
        ],
    ),
}

HEADER_TO_DB: dict[str, str] = {
    "sie_Sie": "sie_sie",
    "German_Sentence": "german_sentence",
    "English_Sentence": "english_sentence",
    "past_participle": "past_participle",
    "simple_past": "simple_past",
    "Comparative": "comparative",
    "Superlative": "superlative",
}

# Required DB column names that must be non-empty for each table
REQUIRED_FIELDS: dict[str, list[str]] = {
    "verbs": ["type", "english", "german_sentence", "english_sentence"],
    "nouns": ["type", "article", "english", "german_sentence", "english_sentence"],
    "adverbs_adjectives": ["type", "english", "german_sentence", "english_sentence"],
}

# A1, A2, B1, B2, C1, C2 with optional .1 or .2 sub-level
VALID_LEVEL = re.compile(r"^(A1|A2|B1|B2|C1|C2)(\.[12])?$")

UPSERT_CHUNK_SIZE = 200
MAX_RETRIES = 3


class ValidationError(Exception):
    """Raised when an Excel file fails structural or row-level validation."""


class _LevelAwareFormatter(logging.Formatter):
    """Plain message for INFO/DEBUG; level-prefixed for WARNING and above."""

    def format(self, record: logging.LogRecord) -> str:
        msg = record.getMessage()
        if record.levelno >= logging.WARNING:
            return f"[{record.levelname}] {msg}"
        return msg


def _setup_logging(verbose: bool, quiet: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING if quiet else logging.INFO
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_LevelAwareFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)
    # Keep third-party HTTP libraries quiet even in --verbose mode
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _db_col(header: str) -> str:
    return HEADER_TO_DB.get(header, header.lower())


def _clean(value: Any) -> Any:
    """Strip regular and non-breaking whitespace from strings; return None for empty."""
    if isinstance(value, str):
        return value.replace("\xa0", " ").strip() or None
    return value


def compute_id(level: str, word: str) -> str:
    raw = f"{level.lower()}|{word.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def compute_content_hash(row: dict[str, Any]) -> str:
    concatenated = "|".join(
        str(row[k]) if row[k] is not None else ""
        for k in sorted(row.keys())
        if k not in ("id", "content_hash")
    )
    return hashlib.sha256(concatenated.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Excel reading and validation
# ---------------------------------------------------------------------------

def read_excel(table: str) -> list[dict[str, Any]]:
    """Read and validate the Excel file for a table.

    Raises ValidationError on any structural or row-level problem.
    """
    filename, headers = TABLE_CONFIG[table]
    path = DATA_DIR / filename

    if not path.exists():
        raise ValidationError(f"'{filename}' not found at {path}")

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        # Multiple sheets → abort: only one sheet is expected
        if len(wb.sheetnames) > 1:
            raise ValidationError(
                f"'{filename}' has multiple sheets: {wb.sheetnames}\n"
                f"  Remove all but one sheet and retry."
            )

        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)

        # Read and validate the header row
        try:
            header_row = next(rows_iter)
        except StopIteration:
            raise ValidationError(f"'{filename}' is completely empty.")

        actual = [
            str(c).replace("\xa0", " ").strip() if c is not None else ""
            for c in header_row
        ]
        # Drop trailing empty header cells — openpyxl commonly pads the header row.
        while actual and actual[-1] == "":
            actual.pop()

        expected_cols = actual[: len(headers)]
        extra_cols = actual[len(headers):]

        if expected_cols != headers:
            lines = [
                f"'{filename}' column mismatch:",
                f"  Expected : {headers}",
                f"  Got      : {actual}",
            ]
            missing = [h for h in headers if h not in actual]
            unexpected = [h for h in expected_cols if h and h not in headers]
            if missing:
                lines.append(f"  Missing  : {missing}")
            if unexpected:
                lines.append(f"  Unexpected: {unexpected}")
            raise ValidationError("\n".join(lines))

        # Extra columns beyond the expected set are ignored (only their headers
        # are noted). Data in these columns is never read — the row loop below
        # only iterates the expected headers.
        if extra_cols:
            logger.warning(
                "'%s' has %d unrecognised column(s) beyond the expected set — ignoring: %s",
                filename, len(extra_cols), extra_cols,
            )

        level_idx = headers.index("Level")
        word_idx = headers.index("Word")
        image_idx = headers.index("Image") if "Image" in headers else -1
        free_idx = headers.index("Free") if "Free" in headers else -1

        rows: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        validation_errors: list[str] = []

        for row_num, raw_row in enumerate(rows_iter, start=2):  # row 1 is the header
            # Silently skip completely blank rows
            if all(_clean(c) is None for c in raw_row):
                continue

            # Build record — coerce unexpected types (datetime, float) to string
            image_raw: Any = raw_row[image_idx] if image_idx >= 0 and image_idx < len(raw_row) else None
            record: dict[str, Any] = {}
            for j, header in enumerate(headers):
                db_col = _db_col(header)
                val = _clean(raw_row[j] if j < len(raw_row) else None)
                if val is not None and not isinstance(val, str):
                    val = str(val)
                record[db_col] = val

            # Image is a boolean — handle separately so it stays 0/1
            if table == "nouns":
                record["image"] = 1 if image_raw else 0

            # Free is a boolean flag gating the paid tier — coerce to 0/1 robustly
            # (a literal "0" string must NOT read as truthy).
            free_raw: Any = raw_row[free_idx] if 0 <= free_idx < len(raw_row) else None
            free_str = str(free_raw).strip().lower() if free_raw is not None else ""
            record["free"] = 1 if free_str in ("1", "true", "yes", "x", "y") else 0

            # Collect all validation errors for this row before skipping
            row_errors: list[str] = []

            level_raw = _clean(raw_row[level_idx] if level_idx < len(raw_row) else None)
            word_raw = _clean(raw_row[word_idx] if word_idx < len(raw_row) else None)
            level_str = str(level_raw) if level_raw is not None else ""

            if not level_str:
                row_errors.append(f"  Row {row_num}: 'Level' is empty")
            elif not VALID_LEVEL.match(level_str):
                row_errors.append(
                    f"  Row {row_num}: invalid Level {level_str!r} "
                    f"(must be A1/A2/B1/B2/C1/C2, optionally followed by .1 or .2)"
                )

            if not word_raw:
                row_errors.append(f"  Row {row_num}: 'Word' is empty")

            for field in REQUIRED_FIELDS[table]:
                if not record.get(field):
                    label = repr(word_raw) if word_raw else "(unknown word)"
                    row_errors.append(f"  Row {row_num}: required field '{field}' is empty (word={label})")

            if row_errors:
                validation_errors.extend(row_errors)
                continue

            row_id = compute_id(level_str, str(word_raw))
            if row_id in seen_ids:
                logger.warning(
                    "Row %d: duplicate '%s + %s' after lowercasing — keeping first occurrence",
                    row_num, level_raw, word_raw,
                )
                continue

            seen_ids.add(row_id)
            record["id"] = row_id
            record["content_hash"] = compute_content_hash(record)
            rows.append(record)

        if validation_errors:
            raise ValidationError(
                f"'{filename}' has {len(validation_errors)} validation error(s):\n"
                + "\n".join(validation_errors)
            )

        if not rows:
            raise ValidationError(f"'{filename}' contains no valid data rows.")

        return rows
    finally:
        wb.close()


# ---------------------------------------------------------------------------
# HTTP layer with HMAC signing and retry
# ---------------------------------------------------------------------------

def _sign_request(request: httpx.Request) -> None:
    """Sign every outgoing request with HMAC-SHA256.

    Canonical string: METHOD\\nPATH\\nTIMESTAMP\\nSHA256(body_bytes)
    PATH is the request path + query string only (e.g. "/state/verbs") — not the
    full URL. The scheme/host/port are excluded so that proxy normalisation,
    trailing-slash, or default-port differences between client and Worker can
    never silently break signature verification.
    The raw API_KEY never travels over the wire — only the signed digest does.
    The Worker rejects signatures with a timestamp older than 5 minutes.
    """
    timestamp = str(int(time.time()))
    body_hash = hashlib.sha256(request.content).hexdigest()
    path = request.url.raw_path.decode("ascii")  # path + query, e.g. "/sync/verbs"
    canonical = f"{request.method}\n{path}\n{timestamp}\n{body_hash}"
    signature = hmac.new(API_KEY.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    request.headers["X-Timestamp"] = timestamp
    request.headers["X-Signature"] = signature


def _request_with_retry(call) -> httpx.Response:
    """Call call() up to MAX_RETRIES times with exponential backoff.

    Retries on network errors and 5xx responses. Does not retry 4xx errors.
    """
    for attempt in range(MAX_RETRIES):
        try:
            response = call()
            if response.status_code >= 500 and attempt < MAX_RETRIES - 1:
                wait = 2 ** attempt
                logger.warning(
                    "Server error %s, retrying in %ds... (%d/%d)",
                    response.status_code, wait, attempt + 1, MAX_RETRIES,
                )
                time.sleep(wait)
                continue
            return response
        except (httpx.NetworkError, httpx.TimeoutException) as exc:
            if attempt == MAX_RETRIES - 1:
                raise
            wait = 2 ** attempt
            logger.warning(
                "%s, retrying in %ds... (%d/%d)",
                exc.__class__.__name__, wait, attempt + 1, MAX_RETRIES,
            )
            time.sleep(wait)
    raise RuntimeError("retry loop exhausted")  # unreachable


def get_db_state(client: httpx.Client, table: str) -> dict[str, str]:
    response = _request_with_retry(lambda: client.get(f"{WORKER_URL}/state/{table}"))
    response.raise_for_status()
    return response.json()


def post_sync(
    client: httpx.Client,
    table: str,
    upsert: list[dict[str, Any]],
    delete: list[str],
) -> None:
    # Chunk upserts to stay within D1 batch limits; deletes go on the first chunk only
    chunks = [upsert[i: i + UPSERT_CHUNK_SIZE] for i in range(0, max(len(upsert), 1), UPSERT_CHUNK_SIZE)]
    for chunk_idx, chunk in enumerate(chunks):
        chunk_delete = delete if chunk_idx == 0 else []
        response = _request_with_retry(lambda: client.post(
            f"{WORKER_URL}/sync/{table}",
            json={"upsert": chunk, "delete": chunk_delete},
            timeout=60.0,
        ))
        response.raise_for_status()


# ---------------------------------------------------------------------------
# Diff and sync orchestration
# ---------------------------------------------------------------------------

def compute_diff(
    excel_rows: list[dict[str, Any]],
    db_state: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Returns (to_insert, to_update, to_delete)."""
    excel_by_id = {row["id"]: row for row in excel_rows}

    to_insert: list[dict[str, Any]] = []
    to_update: list[dict[str, Any]] = []
    for row_id, row in excel_by_id.items():
        if row_id not in db_state:
            to_insert.append(row)
        elif db_state[row_id] != row["content_hash"]:
            to_update.append(row)

    to_delete = [row_id for row_id in db_state if row_id not in excel_by_id]
    return to_insert, to_update, to_delete


def sync_table(
    client: httpx.Client,
    table: str,
    dry_run: bool,
) -> dict[str, int]:
    """Sync one table. Returns counts of inserted, updated, and deleted rows."""
    logger.info("\n[%s]", table)

    logger.debug("  Reading and validating Excel...")
    excel_rows = read_excel(table)
    logger.info("  %d valid rows in Excel.", len(excel_rows))

    logger.debug("  Fetching DB state...")
    db_state = get_db_state(client, table)
    logger.info("  %d rows in DB.", len(db_state))

    to_insert, to_update, to_delete = compute_diff(excel_rows, db_state)
    counts = {"inserted": len(to_insert), "updated": len(to_update), "deleted": len(to_delete)}

    logger.info(
        "  Diff: %d to add, %d to update, %d to delete.",
        counts["inserted"], counts["updated"], counts["deleted"],
    )

    if not to_insert and not to_update and not to_delete:
        logger.info("  Already in sync.")
        return counts

    if dry_run:
        logger.info("  [DRY RUN] No changes written.")
        return counts

    post_sync(client, table, to_insert + to_update, to_delete)
    logger.info("  Done.")
    return counts


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync German vocabulary Excel files to Cloudflare D1.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing anything to the DB.",
    )
    parser.add_argument(
        "--table",
        choices=list(TABLE_CONFIG.keys()),
        metavar="TABLE",
        help=f"Sync only one table. Choices: {', '.join(TABLE_CONFIG.keys())}.",
    )
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Show debug-level detail (per-step progress).",
    )
    verbosity.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Only show warnings and errors (the final summary still prints).",
    )
    args = parser.parse_args()

    _setup_logging(args.verbose, args.quiet)

    missing = [k for k in ("WORKER_URL", "API_KEY") if not os.environ.get(k)]
    if missing:
        logger.error("Missing environment variables: %s", ", ".join(missing))
        logger.error("Copy sync/.env.example to sync/.env and fill in the values.")
        sys.exit(1)

    if not WORKER_URL.startswith("https://"):
        logger.error("WORKER_URL must use https:// (got %r).", WORKER_URL)
        logger.error("Plaintext http would expose signed requests in transit.")
        sys.exit(1)

    tables = [args.table] if args.table else list(TABLE_CONFIG.keys())

    if args.dry_run:
        logger.info("[DRY RUN] No changes will be written to the DB.")

    totals: dict[str, int] = {"inserted": 0, "updated": 0, "deleted": 0}
    failures: list[str] = []

    with httpx.Client(event_hooks={"request": [_sign_request]}) as client:
        for table in tables:
            try:
                result = sync_table(client, table, dry_run=args.dry_run)
            except ValidationError as exc:
                logger.error("%s: %s", table, exc)
                failures.append(table)
                continue
            except httpx.HTTPError as exc:
                logger.error("%s: request failed: %s", table, exc)
                failures.append(table)
                continue
            for key in totals:
                totals[key] += result[key]

    dry_label = " (dry run — no changes written)" if args.dry_run else ""
    print(f"\n{'─' * 44}")
    print(f"Summary{dry_label}")
    print(f"  Added   : {totals['inserted']}")
    print(f"  Updated : {totals['updated']}")
    print(f"  Deleted : {totals['deleted']}")
    if failures:
        print(f"  Failed  : {len(failures)} table(s) — {', '.join(failures)}")
    print(f"{'─' * 44}")

    if failures:
        sys.exit(1)
    if not args.dry_run:
        print("Sync complete.")


if __name__ == "__main__":
    main()
