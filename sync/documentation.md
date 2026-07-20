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
python sync.py --skip-invalid         # skip invalid rows, sync the rest
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
| `--skip-invalid` | Rows that fail row-level validation (empty required field, bad Level, empty Word) are skipped with a warning instead of failing the whole table; the remaining valid rows sync normally. A skipped word that already exists in the DB is **preserved, not deleted** — the previously-synced version stays live until the row is fixed. Structural errors (missing file, bad headers, multiple sheets) still abort the table. |
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
| Any data row has validation errors (see below) | All errors listed, then abort — unless `--skip-invalid` is set, in which case the bad rows are skipped with a warning and the rest sync |
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

**Type** must be the table's canonical value (checked after lowercasing, so `Verb`/`VERB`
are fine; `Verrb` is not) — per table, not one global set, so a `verb` row pasted into
`nouns.xlsx` fails just like a typo:

| Table | Allowed Type |
|---|---|
| `verbs` | `verb` |
| `nouns` | `noun` |
| `adverbs_adjectives` | `adverb` or `adjective` |

Previously a typo'd Type synced silently to D1 and the app misclassified the word at
runtime. Now it's a row-level validation error: the sync aborts with the row number, raw
cell value, and word — or skips the row under `--skip-invalid` with the usual
preserve-don't-delete protection for a previously-synced word.

**Required fields per table** (must be non-empty):

| Table | Required fields |
|-------|-----------------|
| verbs | Type, Word, English, German_Sentence, English_Sentence |
| nouns | Type, Article, Word, English, German_Sentence, English_Sentence |
| adverbs_adjectives | Type, Word, English, German_Sentence, English_Sentence |

**Cross-table id guard**: after all tables are read (full runs only, not `--table`), the sync
aborts if the same Level+Word exists in two tables. `id = sha256(level|word)` has no table
component, so such a pair would share one id — harmless inside D1, but corrupting everywhere
ids are global (the audio cache, pack members, the image decisions store). The same guard runs
in `audio_sync.py` and `media_replace.py`.

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

python audio_sync.py              # synth changed words, build packs, upload changed
python audio_sync.py --dry-run    # synth + build locally, upload nothing
python audio_sync.py --no-synth   # rebuild/upload packs from the existing cache
python audio_sync.py --prune-files # also delete orphaned per-word MP3s from R2
```

### Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Synthesize + build packs locally; upload nothing. Skips all R2 access. |
| `--no-synth` | Skip synthesis; build packs from the existing cache (missing MP3s are pulled from R2). |
| `--resynth` | Force fresh TTS for **every** word, ignoring both the local cache and R2 (then re-upload). Use after deleting R2 / changing the voice recipe. |
| `--force` | Re-upload every pack even if unchanged. Recovery for when R2 holds a stale blob whose bytes don't match the manifest's `sha`. |
| `--prune-files` | **After** uploading, delete `audio/files/<hash>.mp3` objects in R2 that the current vocabulary no longer references (orphans). Opt-in, since it deletes. Skipped under `--dry-run`. |
| `-v` / `-q` | Verbose / quiet logging. |

**Targeted replacements**: committed per-clip overrides in `sync/audio_overrides.json`
(written by `media_replace.py --approve`, see the media-replacement section) are applied
during collection — a replaced clip gets a new recipe hash (take/voice/hint) and flows
through synthesis, packing and publish like any changed word. Clips without an override
are hash-identical to before the feature existed.

What it does:
1. Reads every table; for each word derives `(text, voice)` — nouns spoken as
   `"<article> <word>"`, other types as the bare word — and an `audio_hash` of
   that synthesis input. The voice is picked **deterministically per word** from a
   gender-appropriate pool (see `audio_engine.py`), so the same word always maps to
   the same voice.
2. Synthesizes only words whose `audio_hash` changed or whose MP3 is missing
   (local cache in `sync/audio_cache/`). Text-only edits never re-synthesize.
   Every synthesized MP3 is also mirrored to R2 at `audio/files/<audio_hash>.mp3`,
   and a cache miss pulls those canonical bytes from R2 rather than re-synthesizing
   — so audio is byte-stable across machines and cache clears.
3. Groups words into packs: `free` (every `Free=1` word) and `<type>s/<level>`
   (e.g. `nouns/a1.1`). Each pack is a single `.pack` file:
   `[4-byte BE header length][JSON header][concatenated mp3 bytes]`.
4. Uploads packs whose blob digest (`sha`) changed, then writes `audio/manifest.json`
   (each pack's `hash`, `sha`, bytes + which packs each scope may download). The read
   worker serves the manifest scope-filtered and streams packs from R2.

### Pruning orphaned MP3s (`--prune-files`)

The per-word MP3s in `audio/files/` are content-addressed by `audio_hash`. When the
synthesis recipe changes — e.g. bumping `ENGINE_VERSION` or changing the voice pools
— every word gets a **new** `audio_hash`, so the previous `audio/files/<old_hash>.mp3`
objects become unreferenced. They're harmless but waste storage.

`--prune-files` runs after a successful upload, lists everything under `audio/files/`,
and deletes any object whose hash isn't in the current word set. The typical rebuild:

```bash
python audio_sync.py --dry-run        # preview
python audio_sync.py --prune-files    # rebuild + upload, then clean up old MP3s
```

It only touches `audio/files/`; pack blobs (`audio/packs/`) are left alone.

### Audio configuration

| Variable | File | Purpose |
|----------|------|---------|
| `AZURE_SPEECH_KEY` | `sync/.env` | Azure Speech / Foundry resource key (TTS synthesis) |
| `AZURE_SPEECH_ENDPOINT` | `sync/.env` | Foundry / custom-domain resource URL, e.g. `https://<name>.cognitiveservices.azure.com` |
| `AZURE_SPEECH_REGION` | `sync/.env` | *Alternative* to endpoint: a classic regional Speech resource, e.g. `westeurope` |
| `R2_ACCOUNT_ID` | `sync/.env` | Cloudflare account id (R2 S3 endpoint) |
| `R2_ACCESS_KEY_ID` | `sync/.env` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | `sync/.env` | R2 API token secret |
| `R2_BUCKET` | `sync/.env` | Target R2 bucket (e.g. `german-vocabulary-media`) |

Synthesis uses the **Azure Cognitive Services Speech SDK**
(`azure-cognitiveservices-speech`). The SDK natively handles an Azure AI Foundry /
custom-domain resource from `AZURE_SPEECH_ENDPOINT` + `AZURE_SPEECH_KEY` — it
discovers the region and manages auth tokens itself (the plain REST API does not, so
a custom-domain resource returns 404/401 there). Voices are picked per word from
gender pools in `audio_engine.py`; bump `ENGINE_VERSION` there to force a full
re-synthesis when the recipe (voices/prosody/backend) changes. To force a one-off
fresh synthesis ignoring both the local cache and R2, run with `--resynth`.

> Note: the HD "Dragon" voices (`de-DE-…:DragonHDLatestNeural`) are **not** available
> on this resource — they return "Unsupported voice". Use the standard `…Neural` /
> `…MultilingualNeural` names.


### Manual setup before it runs
`wrangler r2 bucket create german-vocabulary-media`
Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET to sync/.env; regenerate requirements.txt (uv pip compile / pip-compile) and pip install.
`python audio_sync.py` (synthesizes + uploads packs + manifest).
Redeploy the read worker (wrangler deploy).
Build the app in Xcode.

## Image pipeline (`image_sync.py`)

Sources a **premium picture for every noun flagged** in the Image column (`x` or `y`) into the
decisions store + the durable R2 master mirror. Publishing the image packs/catalog is
`media_publish.py`'s job (it reads the decisions store) — the old in-place manifest publish here
was removed (audit H7). Funnel: stock/CC search → CLIP pre-rank →
smart-crop → **HEIC** master (≤500 KB) → Content-Safety → GPT-4o verify → auto-approve or queue for
review → DALL·E fallback. Idempotent + resumable: an **approved image never changes** unless the
word's gloss/word/sentence changes (decisions live in `image_decisions.json`, which is committed).
Full design: `flashcard-german/Others/Docs/image_generation.md`; requirements:
`.../Others/Requirements/images.md`.

```bash
# one-time: add the image deps (Pillow, pillow-heif, open-clip-torch, torch, openai, azure-*) and install
#   uv pip compile requirements.in -o requirements.txt && uv pip install -r requirements.txt
```

### Tools & flags

`python image_sync.py` — source/verify/pack/publish what's needed.
- `--dry-run`     build/report locally, upload nothing
- `--no-source`   skip sourcing; (re)build/publish from existing decisions + cache only
- `--limit N`     process at most N not-yet-settled nouns this run (use `--limit 20` as a first smoke test)
- `--force`       re-upload every image pack (recovery)
- `--prune-files` after publishing, delete `image/files/` masters in R2 no longer referenced
- `-v` / `-q`     verbosity

`python image_review.py` — opens a local, keyboard-driven contact sheet for the LOW-CONFIDENCE nouns
(1–9 pick · n none · s/→ skip). Writes picks straight into `image_decisions.json`. `--port` (default
8765), `--no-open`.

`python image_regen.py <word|id> …` — redo specific noun(s) on demand (overrides the pin; republishes
only those). Default is **re-search** (no flag); `--generate [--style photo|illustration] [--prompt "…"]`
to generate via Foundry; `--image <file|url>` to supply your own; `--dry-run` to preview.

### Keys (sync/.env, never committed)
`PIXABAY_API_KEY`, `PEXELS_API_KEY` (stock); `AZURE_FOUNDRY_ENDPOINT` / `AZURE_FOUNDRY_KEY` (+
`AZURE_FOUNDRY_VERIFY_DEPLOYMENT`, `AZURE_FOUNDRY_IMAGE_DEPLOYMENT`, `AZURE_FOUNDRY_API_VERSION`) for
the verifier + generation; optional `AZURE_VISION_*` (smart crop) and `AZURE_CONTENT_SAFETY_*`; plus
the shared `R2_*`. Missing optional services degrade gracefully (no CLIP → source order; no verifier →
everything goes to review; no Content Safety → a one-time warning).

### Run order
`python sync.py` (text) → `python image_sync.py` (images) → `python image_review.py` (the uncertain
ones) → commit `image_decisions.json`. **No worker deploy needed** — images ride the existing
`/v1/audio/*` endpoints. Build the app in Xcode.

---

## Approved image audit (`image_audit.py`)

`image_audit.py` is a read-only audit tool for the complete set of approved noun images. It never
changes `nouns.xlsx`, `image_decisions.json` or `image_cache/`. Its generated contact sheets and
full-resolution JPEG inspection copies default to `sync/image_review/audit/` and remain untracked.

```bash
# From sync/ and using the project virtual environment:
.venv/bin/python image_audit.py prepare --verify-hashes
.venv/bin/python image_audit.py inspect 71 Posaune af09fe7d7a9f1958
# Complete findings.csv, then render a checked Markdown report:
.venv/bin/python image_audit.py report
# Try to identify approvals orphaned by earlier workbook changes:
.venv/bin/python image_audit.py recover-history
```

`prepare` validates the approved decision store against the current noun workbook, decodes every
approved HEIC, optionally verifies each content hash, and creates a numbered manifest plus contact
sheets. `inspect` accepts an audit number, noun ID, complete image hash or German noun. `report`
rejects duplicate or invalid findings before joining them to the manifest. `recover-history` can
only recover orphan identities when earlier workbook versions were committed to Git.

---

## Targeted media replacement (`media_replace.py`)

Redo the audio and/or image for SPECIFIC words, driven by a backlog sheet:
`data/media_replacements.xlsx`. Add a row whenever you notice a bad clip or picture; run the
tool whenever you like. The tool records intent and previews — the normal pipelines
(`audio_sync.py`, `image_sync.py`, `image_review.py`) do the heavy work.

### Sheet columns

| Column | Who fills it | Meaning |
|--------|--------------|---------|
| `Word`, `Type` | you | Identify the word (`die Stadt` and `Stadt` both work). Type = `noun`/`verb`/`adjective`/`adverb` and picks the table. |
| `Level (auto)` | tool | Filled on resolution. Fill it yourself only when the tool reports the word exists at several levels. |
| `Replace_Audio` / `Replace_Image` | you | Mark either or both with `x`. |
| `Audio_Variants` | you | Which clips: `all` (default) / `singular` / `plural` / `sentence` / `a+b` combos. |
| `Voice` | you | Optional exact Azure voice pin. Default: each take **rotates to a different voice** within the word's gender-appropriate pool — same text + same neural voice would reproduce the same bad clip. |
| `Pronunciation_Hint` | you | Optional respelling substituted for the word in all spoken text (fixes mispronunciations). |
| `Image_Note` | you | Optional feedback appended to the image-generation prompt (persists like reviewer notes). |
| `Status` | tool | Lifecycle text. **Clear it to request another round** (reject a preview / re-replace). |

### Audio lifecycle (preview → approve → publish)

1. `python media_replace.py` — resolves the word, synthesizes the next take into
   `data/media_preview/` (file names carry variant, take and voice), Status = `PREVIEW`.
2. Listen. Bad? Clear Status and re-run — the take advances, the voice rotates again.
3. `python media_replace.py --approve` (optionally `--approve Hund "die Stadt"`) — commits the
   take to **`sync/audio_overrides.json`**. **Commit this file to git** — a machine without it
   reverts every replacement on its next audio_sync run.
4. `python audio_sync.py` — synthesizes and publishes through the normal pipeline. Only packs
   containing replaced clips re-upload; installed apps re-download only those packs.
   The old master becomes an orphan (`--prune-files` cleans it).

The take enters the audio recipe hash, which is what makes replacement propagate: recipe hash →
pack hash → manifest version → client re-download. Clips without an override hash byte-identically
to before this feature existed (tested), so nothing else ever re-ships.

### Image lifecycle (zero-gap swap)

1. `python media_replace.py` — marks the word's decision `replace_requested`. The **current
   image keeps shipping** (nothing is deleted); Status = `queued`.
2. `python image_sync.py` — generates fresh candidates (with your `Image_Note`), queues review.
   The approved record survives; packs still carry the old image.
3. `python image_review.py` — pick one: the decision is overwritten, the next publish swaps the
   image, the old master becomes an orphan. Status = `done ✓`. If the round produced nothing
   usable, the current image is kept and the request cleared (`kept current`).
   The reviewer's "no sentence" / "regenerate with note" actions now also keep an approved
   image live while the next round runs.

### Flags

| Flag | Meaning |
|------|---------|
| `--approve [WORD …]` | Approve previewed audio takes (all previews, or only the named words). |
| `--dry-run` | Full resolution + planned actions report; changes nothing. |
| `--audio-only` / `--images-only` | Process only that side of the marks. |

The tool never touches R2 and needs no R2 credentials; audio previews need the Azure Speech
keys. Rows that fail validation (unknown word, ambiguous level, image on a non-noun, invalid
variant/voice, duplicate row) get their error in `Status` and never block other rows; the run
exits non-zero. State files: `sync/audio_overrides.json` (committed — approved takes),
`data/media_preview/state.json` (local — preview takes + progress markers).
