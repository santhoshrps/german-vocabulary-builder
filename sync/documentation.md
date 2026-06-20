# sync.py — How It Works

Reads the three local Excel files and synchronises their contents into the Cloudflare D1 database via the Worker API. Each run is fully idempotent: running it twice in a row with no Excel changes makes no DB calls beyond the initial state fetch.

## Usage

```bash
cd sync
source .venv/bin/activate
python sync.py                        # sync all three tables
python sync.py --table verbs          # sync only verbs
python sync.py --dry-run              # preview changes without writing to DB
python sync.py --dry-run --table nouns
python sync.py -v                     # verbose (per-step debug detail)
python sync.py -q                     # quiet (warnings + errors + summary only)
```

Requires `sync/.env` with `WORKER_URL` and `API_KEY` set (copy from `.env.example`).

### Installing dependencies

Dependencies are pinned in a lockfile for reproducible installs:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.in` holds the direct dependencies (human-edited); `requirements.txt`
is the generated lockfile with every direct and transitive package pinned. To
change a dependency, edit `requirements.in` and regenerate:

```bash
pip-compile requirements.in                          # pip-tools
uv pip compile requirements.in -o requirements.txt   # uv
```

---

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Fetches DB state and computes the diff, but does not call `POST /sync`. Prints what would be added, updated, and deleted. Safe to run at any time. |
| `--table TABLE` | Restricts the sync to one table. Choices: `verbs`, `nouns`, `adverbs_adjectives`. |
| `-v`, `--verbose` | Debug-level output: per-step progress (reading Excel, fetching DB state). |
| `-q`, `--quiet` | Suppresses progress chatter — only warnings, errors, and the final summary print. Mutually exclusive with `--verbose`. |

Output uses Python's `logging` module. Progress lines go to `INFO` (default) or
`DEBUG` (`-v`); data warnings (duplicate rows, retries) and failures go to
`WARNING`/`ERROR` and always show unless overridden. The final summary block is
always printed regardless of verbosity.

---

## Sync Flow (per table)

```
Excel file  ──read + validate──▶  rows with IDs and hashes
                                          │
                                          ▼
DB (via Worker)  ──fetch──▶  { id: content_hash }
                                          │
                                          ▼
                                       diff
                                   ┌────┴────┐
                               insert/update  delete
                                   └────┬────┘
                                        ▼
                               POST /sync/:table
                               (skipped on --dry-run)
```

### Step 1 — Read and validate Excel

`read_excel(table)` opens the `.xlsx` file and validates it before processing any rows. The following issues cause an immediate abort:

| Issue | Behaviour |
|-------|-----------|
| File not found | Error + abort |
| More than one sheet | Error + abort (remove extra sheets) |
| File is completely empty | Error + abort |
| Header row doesn't match expected columns exactly | Error + abort (lists missing and unexpected columns) |
| Any data row has validation errors (see below) | All errors listed, then abort |
| No valid rows after parsing | Error + abort |

For each data row:
- **Non-breaking spaces** (`\xa0`) are stripped alongside regular whitespace, so visually identical cells that differ only in invisible characters are treated as equal.
- **Blank rows** (every cell empty) are silently skipped.
- **Unexpected cell types** (datetime, float from formula results) are coerced to their string representation.
- **Image column** (nouns only) is treated as a boolean: any truthy value → `1`, empty/False → `0`.

### Step 2 — Row-level validation

Validation errors are collected for all rows and reported together before aborting, so you see every problem in one run.

**Level** must be one of `A1 A2 B1 B2 C1 C2` with an optional sub-level suffix `.1` or `.2`:

```
A1   A1.1   A1.2
B2   B2.1   B2.2
C1   C1.1   C1.2   ... etc.
```

**Required fields per table** (must be non-empty):

| Table | Required fields |
|-------|-----------------|
| verbs | Type, Word, English, German_Sentence, English_Sentence |
| nouns | Type, Article, Word, English, German_Sentence, English_Sentence |
| adverbs_adjectives | Type, Word, English, German_Sentence, English_Sentence |

### Step 3 — Compute row identity and content hash

Each valid row gets two derived fields:

**`id`** — a stable 16-character hex string uniquely identifying the row:
```
id = sha256(lower(level) + "|" + lower(word))[:16]
```
The same word at the same level always produces the same `id`. A word at A1 and the same word at B2 are two distinct rows.

**`content_hash`** — a fingerprint of all field values:
```
content_hash = sha256(field1_value + "|" + field2_value + ...)
```
Fields are sorted alphabetically by key before concatenation so the hash is always stable regardless of dict insertion order. `None` values are treated as empty strings.

### Step 4 — Fetch DB state

`GET /state/:table` returns a flat map of every row currently in the DB:
```json
{ "<id>": "<content_hash>", ... }
```
Only IDs and hashes are transferred, not full row data.

### Step 5 — Diff

`compute_diff` compares Excel rows against the DB state, distinguishing three cases:

| Situation | Action |
|-----------|--------|
| `id` in Excel, not in DB | **Insert** — new word |
| `id` in both, `content_hash` differs | **Update** — a field changed |
| `id` in DB, not in Excel | **Delete** — word removed |
| `id` in both, hashes match | **Skip** — no change |

Inserts and updates are combined into a single upsert list (`INSERT … ON CONFLICT DO UPDATE`). The DB does not need to know which is which.

### Step 6 — Apply changes

`POST /sync/:table` sends:
```json
{
  "upsert": [ { all columns for each added/changed row }, ... ],
  "delete": [ "id1", "id2", ... ]
}
```

Upserts and deletes run as a single atomic D1 batch. Large upsert sets are split into chunks of 200 rows to stay within D1's batch limit; deletes are always sent in the first chunk.

This step is skipped entirely when `--dry-run` is active.

---

## What triggers each operation

| You do this in Excel | sync.py does this |
|----------------------|-------------------|
| Add a new row | Inserts it into the DB |
| Delete a row | Removes it from the DB |
| Change any field in a row | Updates that row (all columns overwritten) |
| Move a word to a different level | Old level+word is deleted; new one is inserted |
| Rename a word | Old id is deleted; new id is inserted |
| Run with no changes | Nothing sent to the DB |

---

## Request Authentication

Every request is signed with HMAC-SHA256. The raw `API_KEY` secret **never travels over the wire** — only a signed digest does.

### How signing works

For each outgoing request, `_sign_request` computes:

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256(body_bytes)
signature = HMAC-SHA256(API_KEY, canonical)
```

`PATH` is the request path and query string only (e.g. `/state/verbs`) — **not** the
full URL. Scheme, host, and port are deliberately excluded so that proxy
normalisation, trailing-slash handling, or default-port differences between the
client and the Worker can never silently break signature verification. The client
derives it from `request.url.raw_path`; the Worker derives the identical string
from `url.pathname + url.search`.

Two headers are added to the request:

| Header | Value |
|--------|-------|
| `X-Timestamp` | Unix timestamp (seconds) at time of signing |
| `X-Signature` | Hex-encoded HMAC-SHA256 digest |

### How the Worker verifies

1. **Presence check** — rejects if either header is missing.
2. **Replay window** — rejects if `|now − X-Timestamp| > 300 seconds` (5 minutes). An intercepted request is useless after this window.
3. **Signature check** — recomputes the canonical string and compares the expected HMAC against `X-Signature` using a timing-safe byte comparison.

### Why this is stronger than a static key

| Static `X-API-Key` | HMAC signing |
|--------------------|-------------|
| Key travels in every request | Key never leaves the local machine |
| Intercepted request replayable forever | Intercepted request expires in 5 minutes |

---

## Retry on network errors

HTTP calls to the Worker are wrapped with `_request_with_retry`. On a network error (`NetworkError`, `TimeoutException`) or a 5xx response, the call is retried up to `MAX_RETRIES` (3) times with exponential backoff: 1 s, 2 s, 4 s. 4xx errors (auth failure, bad request) are not retried.

---

## Summary output

At the end of every run, a summary is printed across all synced tables:

```
────────────────────────────────────────────
Summary
  Added   : 12
  Updated : 3
  Deleted : 1
────────────────────────────────────────────
```

With `--dry-run`, the header says `Summary (dry run — no changes written)`.

---

## Configuration

| Variable | File | Purpose |
|----------|------|---------|
| `WORKER_URL` | `sync/.env` | Base URL of the deployed Cloudflare Worker |
| `API_KEY` | `sync/.env` | Secret used to sign requests (never sent raw) |
| `DATA_DIR` | hardcoded | Parent directory's `data/` folder |
| `UPSERT_CHUNK_SIZE` | hardcoded (200) | Max rows per DB batch call |
| `MAX_RETRIES` | hardcoded (3) | Max retry attempts on transient errors |

---

## Audio pipeline (`audio_sync.py`)

Synthesizes a pronunciation MP3 per word and uploads grouped **packs** to
Cloudflare R2. Runs independently of the text sync (`sync.py`) but reuses its
Excel reader, so word ids match exactly (`sha256(level|word)[:16]`).

```bash
# one-time: add the audio deps and regenerate the lockfile
#   uv pip compile requirements.in -o requirements.txt   (or pip-compile)
#   pip install -r requirements.txt

python audio_sync.py            # synth changed words, build packs, upload changed
python audio_sync.py --dry-run  # synth + build locally, upload nothing
python audio_sync.py --no-synth # rebuild/upload packs from the existing cache
```

What it does:
1. Reads every table; for each word derives `(text, voice)` — nouns spoken as
   `"<article> <word>"`, other types as the bare word — and an `audio_hash` of
   that synthesis input.
2. Synthesizes only words whose `audio_hash` changed or whose MP3 is missing
   (local cache in `sync/audio_cache/`). Text-only edits never re-synthesize.
3. Groups words into packs: `free` (every `Free=1` word) and `<type>s/<level>`
   (e.g. `nouns/a1.1`). Each pack is a single `.pack` file:
   `[4-byte BE header length][JSON header][concatenated mp3 bytes]`.
4. Uploads only packs whose hash changed, then writes `audio/manifest.json`
   (pack hashes/bytes + which packs each scope may download). The read worker
   serves the manifest scope-filtered and streams packs from R2.

### Audio configuration

| Variable | File | Purpose |
|----------|------|---------|
| `R2_ACCOUNT_ID` | `sync/.env` | Cloudflare account id (R2 S3 endpoint) |
| `R2_ACCESS_KEY_ID` | `sync/.env` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | `sync/.env` | R2 API token secret |
| `R2_BUCKET` | `sync/.env` | Target R2 bucket (e.g. `german-vocabulary-media`) |

Voices/prosody live in `audio_engine.py`. Bump `ENGINE_VERSION` there to force a
full re-synthesis when the recipe changes.


### Manual setup before it runs
`wrangler r2 bucket create german-vocabulary-media`
Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET to sync/.env; regenerate requirements.txt (uv pip compile / pip-compile) and pip install.
`python audio_sync.py` (synthesizes + uploads packs + manifest).
Redeploy the read worker (wrangler deploy).
Build the app in Xcode.