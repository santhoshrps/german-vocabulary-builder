# Sync Protocol

How an iOS client keeps its local SQLite copy in sync with the server, transferring as
little as possible. All data endpoints require a session JWT (see
[authentication.md](authentication.md)) and are filtered by its `scope`.

## Data endpoints

| Endpoint | Returns | Typical size |
|----------|---------|--------------|
| `GET /v1/version` | `{ version }` | tiny |
| `GET /v1/changes?from=…` | coalesced changed/deleted IDs + integrity metadata | proportional to retained changes |
| `GET /v1/manifest` | `{ version, manifest: { table: { id: content_hash } } }` | small |
| `GET /v1/rows/:table?ids=…&version=…` | exact immutable target rows | one batch (≤200) |
| `GET /v1/snapshot-manifest` | immutable full-install manifest + short-lived block grant | one block descriptor per 500–1,000 rows |
| `GET /v1/snapshot-block/:id?snapshot=…&checksum=…` | one immutable zlib block | 500–1,000 rows |
| `GET /v1/snapshot` | legacy NDJSON compatibility fallback | whole (scoped) dataset |

All are implemented in [`src/data.ts`](../src/data.ts) and served through the
version-keyed edge cache (see [caching.md](caching.md)).

## Dataset version

The **version** is a short string that changes whenever the dataset changes. It comes from
`getVersion` ([`src/data.ts`](../src/data.ts)):

1. If `meta.dataset_version` exists (set by the write worker), use it.
2. Before an immutable publisher baseline exists, derive it from each table's
   `COUNT(*)` + `MAX(updated_at)`.
   - `COUNT(*)` changes on **insert/delete**.
   - `MAX(updated_at)` changes on **insert/update** (the write path always stamps
     `updated_at` on upsert).
   - So any change to the data moves the version.

The version is **scope-specific** (`…:free` vs `…:full`). This means a free→full upgrade
always looks "changed" to the client and forces a re-sync, and free users don't re-sync
when only full-tier rows change.

## Steady-state sync (bounded immutable delta)

```
1. GET /v1/version
   └─ same as local? ──▶ done. (nothing transferred)

2. GET /v1/changes?from=<local version>
   └─ validate continuity, generation, scope/language, counts, fingerprints,
      changed/deleted ids, hashes, aliases and type changes

3. GET /v1/rows/:table?ids=<changed ids>&version=<target> // batches ≤200
   └─ apply rows to local SQLite

4. commit word mutations + target cursor in ONE local transaction
```

The routine path never downloads or scans the complete manifest. Immutable
per-version records retain authoritative deletions and exact target row snapshots.
Several missed versions are coalesced deterministically; a gap, incompatible
generation or excessive chain returns 409/410 and selects full recovery.
Coalescing compares endpoint state as well as the latest operation: a word added
and deleted entirely after the client's cursor is omitted as a net no-op, while
delete/re-add, update/delete and genuine adjective/adverb type changes remain
explicit.

The block snapshot remains the safety net for first install, scope/language
changes, an expired cursor, a large editorial publication, explicit repair or
failed integrity validation. The catalogue-wide hash manifest and legacy
single-snapshot transport remain compatibility/recovery fallbacks.

`ETag`/`If-None-Match` short-circuits this: the version is the ETag, so a client already
on the current version gets `304 Not Modified` with no body.

## First-time / full sync (immutable blocks)

The preferred 50k+ path is:

1. `GET /v1/snapshot-manifest` with one fresh App Attest assertion for a
   device-bound session. The response pins generation, version/sequence,
   language, scope, counts/fingerprint and independently compressed block
   metadata, plus a short-lived `download_grant`.
2. Download the manifest's content-addressed blocks with
   `X-Snapshot-Grant`. The grant is HMAC-signed and bound to the session subject,
   scope, language and exact snapshot; it permits no other dataset. A resumed
   install refreshes the grant with
   `/snapshot-manifest?snapshot=<retained snapshot id>`.
3. Verify each compressed size/checksum, decode at most two blocks off-main and
   feed exactly one staging-database writer. Page commits and the durable install
   journal make replay idempotent without retaining the whole catalogue.
4. Validate exact table/global counts, stable-ID uniqueness and global
   fingerprint; validate and checksum the complete `/aliases` graph as inert
   snapshot-specific staging; seal the staged SQLite WAL; and reopen the
   replacement to prove its exact transactional cursor.
5. Durably switch the local content pointer and staged alias graph before
   publishing the replacement container. A crash after the pointer switch can
   finish alias installation and cleanup from local staged files while offline;
   aliases are never applied to the superseded catalogue.
6. If the frozen snapshot sequence is behind the current version, immediately
   catch up through `/changes`; never mix generations inside the full install.
   Client rechecks are bounded so continuous publication cannot hold onboarding.
   The publisher refreshes the full snapshot set at age 200 inside the retained
   256-version feed window, so this catch-up source cannot expire.

Blocks use the standard RFC 1950 zlib envelope around an RFC 1951 DEFLATE
payload, including the Adler-32 trailer, and contain NDJSON rows without a table
wrapper. Table identity comes from the signed/checksummed manifest. A normal
installation contains the complete entitled scope—CEFR level never partitions
the download.

The legacy `GET /v1/snapshot` NDJSON response remains available until all deployed
clients understand blocks. It is selected only for 404/501 or an explicitly
unsupported block contract, not for an offline, checksum, storage or cancellation
failure.

## Tiers

A `free` boolean column marks the curated preview rows. The session's `scope` decides what
every query returns ([`scopeWhere` in src/data.ts](../src/data.ts)):

| scope | sees |
|-------|------|
| `free` | only rows with `free = 1` (the ~100-word preview) |
| `full` | the entire dataset |

The filter is applied to **version, manifest, rows, and snapshot alike** — including the
`rows` endpoint, so a free client cannot fetch a full-tier row even by guessing its id.
The version differing by scope guarantees a client re-syncs cleanly when it upgrades from
free to full.

See [promo-codes.md](promo-codes.md) for how a tier is granted.

## Why this design

- **Cheap steady state** — polling `version` is a tiny request; most syncs stop there.
- **Catalogue-independent routine work** — one changed word transfers and looks up
  approximately one word whether the installed catalogue has 500 or 50,000 rows.
- **Crash-proof publication** — canonical mutations, immutable history and the visible
  version pointer are one D1 transaction.
- **Exact races** — version-pinned row snapshots cannot mix two publications.
- **Authoritative deletes** — retained tombstones preserve removals without a manifest scan.
- **Memory-safe bulk** — independent blocks, bounded decode concurrency,
  backpressure and one staging writer keep peak memory independent of catalogue size.
- **Cache-friendly** — immutable blocks have one-year cache identities; authorization
  grants gate access without making the block bytes user-specific.

## Client pseudocode

```text
local_version = read_local_version()
server = GET /v1/version
if server.version == local_version: return  // up to date

if local_store_empty or cursor_incompatible:
    manifest = GET /v1/snapshot-manifest     // one fresh assertion when device-bound
    resume journal(manifest)
    concurrently download 2–4 immutable blocks using manifest.download_grant
    decode at most 2; page-write through exactly 1 staging writer
    validate + seal + atomically activate staged catalogue
    if manifest.sequence < server.sequence: apply /changes catch-up
else:
    feed = GET /v1/changes?from=local_version
    validate feed
    for batch in chunks(feed.changed, 200):
        rows = GET /v1/rows/table?ids=batch&version=feed.to_version
    atomically apply rows + deletions + feed.to_cursor

// Missing block endpoints use legacy /manifest then /snapshot. Transient block
// failures retain the journal and retry; they do not trigger the legacy payload.
```
