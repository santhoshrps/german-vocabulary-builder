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
| `GET /v1/manifest` | session JWT |
| `GET /v1/rows/:table` | session JWT |
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

Current dataset version for the session's scope. Cheap poll to decide whether to sync.

**Response 200** — headers `ETag: "<version>"`, `Cache-Control: public, max-age=30`
```json
{ "version": "<scoped version>" }
```

---

## `GET /v1/manifest`

`{id: content_hash}` per table for the session's scope. Diff against the local store to
find adds/changes/deletes.

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

## `GET /v1/rows/:table?ids=a,b,c`

Full rows for specific ids (the changed set from a manifest diff). Scope-filtered: a free
session cannot retrieve full-tier rows even by id.

**Path** — `:table` ∈ `verbs | nouns | adverbs_adjectives`
**Query** — `ids` = comma-separated row ids, **max 200**.

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
