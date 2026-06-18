# sync.py — How It Works

Reads the three local Excel files and synchronises their contents into the Cloudflare D1 database via the Worker API. Each run is fully idempotent: running it twice in a row with no Excel changes makes no DB calls beyond the initial state fetch.

## Usage

```bash
cd sync
source .venv/bin/activate
python sync.py
```

Requires `sync/.env` with `WORKER_URL` and `API_KEY` set (copy from `.env.example`).

---

## Sync Flow (per table)

```
Excel file  ──read──▶  compute IDs & hashes
                              │
                              ▼
DB (via Worker) ──fetch──▶  { id: content_hash }
                              │
                              ▼
                          diff
                         /    \
                    upsert    delete
                         \    /
                          POST /sync/:table
```

### Step 1 — Read Excel

`read_excel(table)` opens the `.xlsx` file with openpyxl and builds a list of row dicts using the column headers defined in `TABLE_CONFIG`. It:

- Skips the first row (headers) and any rows where `Level` or `Word` is blank (guards against trailing empty rows).
- Strips leading/trailing whitespace from all string values.
- Normalises the `Image` column for nouns to `1`/`0` (boolean stored as integer).
- Warns and skips duplicate rows that produce the same ID (same level + word after lowercasing).

### Step 2 — Compute row identity and content hash

Each row gets two derived fields:

**`id`** — a stable 16-character hex string uniquely identifying the row:
```
id = sha256(lower(level) + "|" + lower(word))[:16]
```
The same word at the same level always produces the same `id`, regardless of any other field values. A word at A1 and the same word at B2 are two distinct rows.

**`content_hash`** — a fingerprint of all field values:
```
content_hash = sha256(field1_value + "|" + field2_value + ...)
```
Fields are sorted alphabetically by key before concatenation so the hash is always stable. `None` values are treated as empty strings.

### Step 3 — Fetch DB state

`GET /state/:table` returns a flat map of every row currently in the DB:
```json
{ "<id>": "<content_hash>", ... }
```
This is cheap: only IDs and hashes are transferred, not full row data.

### Step 4 — Diff

`compute_diff` compares the Excel rows against the DB state:

| Situation | Action |
|-----------|--------|
| `id` is in Excel but **not** in DB | **Add** — row is new |
| `id` is in both, but `content_hash` differs | **Update** — a field value changed |
| `id` is in DB but **not** in Excel | **Delete** — row was removed from the file |
| `id` is in both and hashes match | **Skip** — no change |

Additions and updates are handled identically: both become an upsert (`INSERT … ON CONFLICT DO UPDATE`). The DB never needs to know whether it's a new row or a changed one.

### Step 5 — Apply changes

`POST /sync/:table` sends:
```json
{
  "upsert": [ { all columns for each added/changed row }, ... ],
  "delete": [ "id1", "id2", ... ]
}
```

Upserts and deletes are executed as a single atomic D1 batch — either all succeed or none do. Large upsert sets are split into chunks of 200 rows to stay within D1's batch statement limit; deletes are always sent in the first chunk.

---

## Request Authentication

Every request is signed with HMAC-SHA256. The raw `API_KEY` secret **never travels over the wire** — only a signed digest does.

### How signing works

For each outgoing request, `_sign_request` computes:

```
canonical = METHOD + "\n" + URL + "\n" + TIMESTAMP + "\n" + SHA256(body_bytes)
signature = HMAC-SHA256(API_KEY, canonical)
```

Two headers are added to the request:

| Header | Value |
|--------|-------|
| `X-Timestamp` | Unix timestamp (seconds) at time of signing |
| `X-Signature` | Hex-encoded HMAC-SHA256 digest |

### How the Worker verifies

1. **Presence check** — rejects immediately if either header is missing.
2. **Replay window** — rejects if `|now - X-Timestamp| > 300 seconds` (5 minutes). An intercepted request is useless after this window.
3. **Signature check** — recomputes the canonical string from the live request and compares the expected HMAC against `X-Signature` using a timing-safe byte comparison. Any mismatch returns `401`.

### Why this is stronger than a static key

| Static `X-API-Key` | HMAC signing |
|--------------------|-------------|
| Key travels in every request | Key never leaves the local machine |
| Intercepted request replayable forever | Intercepted request expires in 5 minutes |
| Compromised in transit = full access | Compromised signature = one request, already expired |

---

## What triggers each operation

| You do this in Excel | sync.py does this |
|----------------------|-------------------|
| Add a new row | Inserts it into the DB |
| Delete a row | Removes it from the DB |
| Change any field in a row | Updates that row in the DB (all columns are overwritten) |
| Move a word to a different level | The old level+word combination is deleted; the new one is inserted (level is part of the ID) |
| Rename a word | Same as above — old ID is deleted, new ID is inserted |
| Run with no changes | Nothing sent to the DB |

---

## Configuration

| Variable | File | Purpose |
|----------|------|---------|
| `WORKER_URL` | `sync/.env` | Base URL of the deployed Cloudflare Worker |
| `API_KEY` | `sync/.env` | Secret that authorises requests to the Worker |
| `DATA_DIR` | hardcoded | Parent directory's `data/` folder |
| `UPSERT_CHUNK_SIZE` | hardcoded (200) | Max rows per DB batch call |
