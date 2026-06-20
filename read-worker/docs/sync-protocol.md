# Sync Protocol

How an iOS client keeps its local SQLite copy in sync with the server, transferring as
little as possible. All data endpoints require a session JWT (see
[authentication.md](authentication.md)) and are filtered by its `scope`.

## The four data endpoints

| Endpoint | Returns | Typical size |
|----------|---------|--------------|
| `GET /v1/version` | `{ version }` | tiny |
| `GET /v1/manifest` | `{ version, manifest: { table: { id: content_hash } } }` | small |
| `GET /v1/rows/:table?ids=…` | `{ version, table, rows: [...] }` | one batch (≤200) |
| `GET /v1/snapshot` | NDJSON, one row per line | whole (scoped) dataset |

All four are implemented in [`src/data.ts`](../src/data.ts) and served through the
version-keyed edge cache (see [caching.md](caching.md)).

## Dataset version

The **version** is a short string that changes whenever the dataset changes. It comes from
`getVersion` ([`src/data.ts`](../src/data.ts)):

1. If `meta.dataset_version` exists (set by the write worker), use it.
2. Otherwise derive it: for each table, hash `COUNT(*)` + `MAX(updated_at)`.
   - `COUNT(*)` changes on **insert/delete**.
   - `MAX(updated_at)` changes on **insert/update** (the write path always stamps
     `updated_at` on upsert).
   - So any change to the data moves the version.

The version is **scope-specific** (`…:free` vs `…:full`). This means a free→full upgrade
always looks "changed" to the client and forces a re-sync, and free users don't re-sync
when only full-tier rows change.

## Steady-state sync (delta)

```
1. GET /v1/version
   └─ same as local? ──▶ done. (nothing transferred)

2. GET /v1/manifest                      // { id: content_hash } for the whole scope
   └─ diff against the local store:
        id present on server, absent locally  → fetch (new)
        id present both, content_hash differs → fetch (changed)
        id absent on server, present locally  → delete

3. GET /v1/rows/:table?ids=<changed ids> // in batches of ≤200
   └─ apply rows to local SQLite

4. save the new version locally
```

The manifest carries `content_hash` per row (the same hash the sync script computes on
the write side), so the client never downloads a row whose content it already has.
**Deletions are detected by absence** — an id in the local store but not in the manifest
is deleted. No tombstones or soft-deletes are needed.

`ETag`/`If-None-Match` short-circuits this: the version is the ETag, so a client already
on the current version gets `304 Not Modified` with no body.

## First-time / full sync (snapshot)

On first run (empty local store) or to reset, the client pulls `GET /v1/snapshot`:

- The body is **NDJSON** — one JSON object per line: `{"t":"<table>","row":{...}}`.
- The phone streams and inserts line-by-line in a single SQLite transaction, without
  buffering the whole payload in memory.
- Cloudflare compresses the response (gzip/brotli) automatically.

For **device sessions**, snapshot additionally requires a fresh App Attest assertion —
fetch `GET /v1/challenge`, sign it, and send `X-Challenge` + `X-Assertion` headers (see
[authentication.md](authentication.md#4-per-request-assertion-on-v1snapshot)). Promo
sessions are exempt.

## Tiers

A `free` boolean column marks the curated preview rows. The session's `scope` decides what
every query returns ([`scopeWhere` in src/data.ts](../src/data.ts)):

| scope | sees |
|-------|------|
| `free` | only rows with `free = 1` (the ~200-word preview) |
| `full` | the entire dataset |

The filter is applied to **version, manifest, rows, and snapshot alike** — including the
`rows` endpoint, so a free client cannot fetch a full-tier row even by guessing its id.
The version differing by scope guarantees a client re-syncs cleanly when it upgrades from
free to full.

See [promo-codes.md](promo-codes.md) for how a tier is granted.

## Why this design

- **Cheap steady state** — polling `version` is a tiny request; most syncs stop there.
- **Minimal transfer** — only changed rows move, identified by content hash.
- **Natural deletes** — absence in the manifest is the delete signal.
- **Memory-safe bulk** — NDJSON streams; the phone never holds the whole dataset at once.
- **Cache-friendly** — the manifest and snapshot are identical for all users at a given
  version+scope, so one cached object serves everyone.

## Client pseudocode

```text
local_version = read_local_version()
server = GET /v1/version
if server.version == local_version: return  // up to date

if local_store_empty:
    stream GET /v1/snapshot                  // (device: + X-Challenge/X-Assertion)
    apply each NDJSON line in a transaction
else:
    m = GET /v1/manifest
    for each table:
        changed = ids where local hash != m[table][id] or id is new
        removed = local ids not in m[table]
        for batch in chunks(changed, 200):
            r = GET /v1/rows/table?ids=batch
            upsert r.rows
        delete removed
save_local_version(server.version)
```
