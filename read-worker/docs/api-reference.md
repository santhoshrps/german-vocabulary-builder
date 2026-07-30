# API Reference

Base path: `/v1`. All responses are JSON unless noted. Errors are `{ "error": "<code>" }`
with the listed HTTP status. Implemented in [`src/index.ts`](../src/index.ts).

## Auth model at a glance

| Endpoint | Auth required |
|----------|---------------|
| `GET /v1/challenge` | none (rate-limited) |
| `POST /v1/devices/register` | App Attest attestation |
| `POST /v1/session` | promo code **or** assertion + StoreKit |
| `GET /v1/version` | session JWT |
| `GET /v1/changes` | session JWT |
| `GET /v1/manifest` | session JWT |
| `GET /v1/rows/:table` | session JWT |
| `GET /v1/snapshot-manifest` | session JWT **+ one fresh assertion** (device sessions) |
| `GET /v1/snapshot-block/:id` | session JWT + snapshot grant |
| `GET /v1/snapshot` | session JWT **+ fresh assertion** (device sessions) |

Rate limiting (per client IP, atomic D1 counters): `challenge` **30/min**, `session`
**10/min**, `devices/register` **10 per 10 min**; exceeding returns
`429 {"error":"rate limited"}`. These values mirror `authBudget` in `src/index.ts` — keep
the two in step.

---

## `GET /v1/challenge`

Issues a one-time, single-use nonce for App Attest attestation/assertion. Valid ~5 min.

**Response 200**
```json
{ "challenge": "<base64url nonce>" }
```

---

## `POST /v1/devices/register`

Registers a device's App Attest key. Call once per install.

**Body**
```json
{ "keyId": "<base64url>", "attestationObject": "<base64>", "challenge": "<from /challenge>" }
```

**Response 200**
```json
{ "deviceId": "<base64url key id>" }
```

**Errors**
| Status | code | When |
|--------|------|------|
| 400 | `missing keyId/attestationObject/challenge` | required field absent |
| 401 | `bad challenge` | challenge unknown or already used |
| 401 | `attestation failed` | App Attest verification failed |

---

## `POST /v1/session`

Mints a session JWT. Two mutually exclusive modes.

**Body — promo (self-test / manual grant)**
```json
{ "promoCode": "LET-ME-IN" }
```

**Body — production (device + purchase)**
```json
{
  "deviceId": "<registered device id>",
  "assertion": "<base64 App Attest assertion>",
  "challenge": "<from /challenge>",
  "signedTransaction": "<StoreKit 2 JWS>"
}
```

**Response 200**
```json
{ "token": "<JWT>", "expiresIn": 3600, "entitlement": "promo|storekit", "scope": "free|full" }
```

**Errors**
| Status | code | When |
|--------|------|------|
| 400 | `invalid body` | body not JSON |
| 400 | `missing deviceId/assertion/challenge/signedTransaction` | production fields absent |
| 401 | `bad challenge` | challenge unknown/used |
| 401 | `unknown device` | device id not registered |
| 401 | `assertion failed` | assertion signature/counter check failed |
| 403 | `invalid promo code` | promo code unknown/inactive/expired |
| 403 | `code already in use on the maximum number of devices` | full-tier promo code bound to `PROMO_DEVICE_CAP` other devices (personal codes, `promo-codes.md` §7) |
| 503 | `device check required - try again shortly` | full-tier promo code with **zero** claims minted without an attested device (App Attest paused) — transient, retryable |
| 403 | `entitlement verification failed` / `no active entitlement` | StoreKit invalid or no qualifying product |

> The two personal-code responses are a **contract with the app**
> (`UnlockFlowCoordinator.redeemOutcome(for:)` matches status + body substring): 403 means
> "dead for this device" (the app drops a stored code and reopens the unlock window), 503
> means "transient — retry, the code is not burned". Keep the strings and statuses in step.

Send the JWT as `Authorization: Bearer <token>` on all data endpoints.

---

## `GET /v1/version`

Current dataset cursor for the session's scope and requested `?lang=`. Cheap poll
to decide whether to sync.

**Response 200** — headers `ETag: "<version>"`, `Cache-Control: public, max-age=30`
```json
{
  "version": "<scoped version>",
  "minClient": 1,
  "dataset_generation": 2,
  "sequence": 42,
  "fingerprint": "xor256-v1:<64 hex>",
  "counts": {"verbs": 10000, "nouns": 20000, "adverbs_adjectives": 20000}
}
```

---

## `GET /v1/changes?from=<installed-version>`

Returns the immutable, scope/language-filtered transition from a retained
installed cursor to the current cursor. The response contains changed IDs and
expected hashes, authoritative deletions, aliases/type changes, counts and
source/target fingerprints—never full word rows.

Several retained versions are deterministically coalesced. `409` reports an
incompatible generation; `410` reports a missing/expired/excessive history
chain. The client then uses its existing manifest/snapshot recovery path.

---

## `GET /v1/manifest`

Recovery-only `{id: content_hash}` per table for the session's scope.

**Request** — optional `If-None-Match: "<version>"` → `304` if current.

**Response 200**
```json
{
  "version": "<scoped version>",
  "manifest": {
    "verbs": { "<id>": "<content_hash>", "...": "..." },
    "nouns": { "...": "..." },
    "adverbs_adjectives": { "...": "..." }
  }
}
```

---

## `GET /v1/rows/:table?ids=a,b,c&version=<target>`

Full rows for specific changed IDs. With `version`, rows come from immutable
delta-sized snapshots at or before that exact target sequence, so a later
publication cannot replace an in-flight response. Without `version`, the route
retains its legacy manifest-recovery behavior. Scope filtering still applies.

**Path** — `:table` ∈ `verbs | nouns | adverbs_adjectives`
**Query** — `ids` = comma-separated row ids, **max 200**; `version` = opaque
target version from `/changes`.

**Response 200**
```json
{ "version": "<scoped version>", "table": "nouns", "rows": [ { "id": "...", "word": "...", "free": 1, "...": "..." } ] }
```

**Errors**
| Status | code | When |
|--------|------|------|
| 400 | `invalid table` | table not in the allowlist |
| 400 | `no ids` | `ids` missing/empty |
| 400 | `too many ids (max 200)` | more than 200 ids |
| 409 | `target version rows unavailable` | target expired, mismatched or missing an advertised immutable row |

---

## `GET /v1/snapshot`

The entire scoped dataset as NDJSON for a first-time/full sync.

**Headers (device sessions)** — in addition to `Authorization`:
| Header | Value |
|--------|-------|
| `X-Challenge` | a nonce from `GET /v1/challenge` |
| `X-Assertion` | base64 App Attest assertion over that challenge |

Promo sessions omit these.

**Response 200** — `Content-Type: application/x-ndjson`, one row per line:
```
{"t":"verbs","row":{"id":"...","word":"...","free":1,"...":"..."}}
{"t":"nouns","row":{"id":"...","word":"...","free":0,"...":"..."}}
```

**Errors**
| Status | code | When |
|--------|------|------|
| 401 | `snapshot requires X-Challenge and X-Assertion headers` | device session missing assertion headers |
| 401 | `bad challenge` | challenge unknown/used |
| 401 | `unknown device` | session's device id not found |
| 401 | `assertion failed` | assertion verification failed |

---

## `GET /v1/snapshot-manifest`

Preferred full-install contract for a 50k+ catalogue. With no `snapshot` query it
returns the current immutable language/scope snapshot. A resumable client may use
`?snapshot=<64-hex snapshot id>` to refresh authorization for that exact retained
frozen snapshot after its session expires.

Device-bound sessions send one fresh `X-Challenge`/`X-Assertion`, using the same
exemptions as legacy `/snapshot`. The response is `private, no-store` because it
contains a subject-bound `download_grant`; immutable block bytes remain publicly
cacheable only after request authentication/grant validation.

**Response 200 (abbreviated)**
```json
{
  "contract_version": 1,
  "snapshot_id": "<64 hex>",
  "sequence": 42,
  "dataset_generation": 2,
  "base_version": "<base version>",
  "version": "<base version>:full",
  "language": "en",
  "scope": "full",
  "schema_version": 2,
  "compression": "zlib",
  "total_count": 50000,
  "table_counts": {
    "verbs": 10000,
    "nouns": 20000,
    "adverbs_adjectives": 20000
  },
  "global_fingerprint": "xor256-v1:<64 hex>",
  "block_count": 68,
  "total_compressed_bytes": 12345678,
  "total_uncompressed_bytes": 45678901,
  "blocks": [{
    "id": "<64 hex>",
    "table": "nouns",
    "index": 0,
    "row_count": 750,
    "compressed_bytes": 180000,
    "uncompressed_bytes": 700000,
    "checksum": "<64 hex>"
  }],
  "manifest_checksum": "<64 hex>",
  "download_grant": "<subject/snapshot-bound signed grant>"
}
```

`sequence` and `download_grant` are transport metadata and are excluded from
`manifest_checksum`; every other manifest field is canonical-JSON checksummed.

## `GET /v1/snapshot-block/:id`

Returns one immutable NDJSON block using the standard RFC 1950 zlib envelope
(RFC 1951 DEFLATE payload plus Adler-32 trailer).

**Query**

- `snapshot=<64-hex snapshot id>` — required.
- `checksum=<64-hex checksum>` — required by clients; mismatch returns 409.

**Headers**

- `Authorization: Bearer <session JWT>`
- `X-Snapshot-Grant: <download_grant from the exact manifest>`

The grant is short-lived and bound to session subject, scope, language and
snapshot. It replaces per-block App Attest assertions, avoiding dozens of
hardware-signing operations while preserving the bulk-download protection.

Successful responses include immutable one-year caching, `ETag`, exact
`Content-Length`, `X-Snapshot-ID`, `X-Block-ID` and `X-Block-Checksum`.

| Status | code | When |
|--------|------|------|
| 400 | `invalid snapshot or block id` | malformed identity |
| 401 | `invalid or expired snapshot grant` | absent, expired, tampered or wrong subject/scope/language/snapshot |
| 404 | `snapshot block unavailable` | unknown/uncommitted block or view mismatch |
| 409 | `snapshot block checksum mismatch` | requested checksum differs |

---

## Common responses

| Status | code | Meaning |
|--------|------|---------|
| 401 | `missing bearer token` | no `Authorization: Bearer` on a data endpoint |
| 401 | `invalid or expired token` | JWT bad or past `exp` |
| 404 | `not found` | unknown route or non-`v1` path |
| 429 | `rate limited` | auth endpoint rate limit exceeded |
| 500 | `internal error` | unhandled error (logged to observability) |

## Response headers worth noting

| Header | On | Meaning |
|--------|----|---------|
| `ETag: "<version>"` | data endpoints | Use with `If-None-Match` for 304s |
| `X-Cache: HIT\|MISS` | cached endpoints | Whether the edge cache served it |
| `Cache-Control` | data endpoints | Per-endpoint TTL (see [caching.md](caching.md)) |
