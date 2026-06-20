# Architecture

## The shape of the problem

The dataset is **identical for every user** and **changes rarely** (only when the Excel
sync runs). That single fact drives every design decision: this is a read-mostly,
highly-cacheable shared dataset, not per-user data. The worker is therefore built to
authenticate a request and then serve a **shared, version-keyed cached object** — so the
database is touched as little as possible.

## Components

```
                         ┌──────────────────────────────────────────────┐
  iOS app                │            Read Worker (this)                 │
  ───────                │                                              │
   App Attest key        │   ┌── auth ──────────────────────────────┐   │
   StoreKit purchase ───▶│   │ challenge → attestation → assertion   │   │
                         │   │ + entitlement (StoreKit / promo)      │   │
                         │   │   → short-lived session JWT (scope)   │   │
                         │   └───────────────────────────────────────┘   │
                         │   ┌── data (JWT-gated, scoped) ──────────┐    │
                         │   │ version · manifest · rows · snapshot  │    │
                         │   └───────────────────────────────────────┘   │
                         └───────────┬───────────────────┬──────────────┘
                                     │                   │
                              Cloudflare KV        Edge Cache API
                          (challenges, rate-limit)  (version-keyed) ──(miss)──▶ D1 (read-only)
```

| Component | Backing | Purpose |
|-----------|---------|---------|
| Auth endpoints | KV + D1 `devices` / `promo_codes` | Verify the app + entitlement, mint a session JWT |
| Data endpoints | Edge Cache → D1 | Serve version / manifest / rows / snapshot, filtered by scope |
| KV namespace | Cloudflare KV | One-time challenge nonces + fixed-window rate limiting |
| Edge cache | Cloudflare Cache API | Shared, version-keyed response cache (the scaling lever) |
| D1 | Cloudflare D1 | Source of truth, shared with the write worker; **read-only** here |

## Request lifecycle

Every request enters [`src/index.ts`](../src/index.ts) `fetch` and flows through:

1. **Path parse** — `/v1/<route>/<sub>`. Anything not under `v1` is a 404.
2. **Rate limit** — `challenge`, `session`, and `devices` are limited per client IP
   (30/min) via KV. The expensive auth endpoints are the abuse surface.
3. **Route + auth**:
   - Auth routes (`challenge`, `devices/register`, `session`) run their own verification.
   - Data routes (`version`, `manifest`, `rows`, `snapshot`) call `requireSession` to
     validate the JWT, derive the `scope`, and (for `snapshot`) require a fresh assertion.
4. **Serve** — data routes build a scoped response and serve it through the
   version-keyed edge cache.
5. **Errors** — a thrown `HttpError` becomes its `{status, code}`; anything else is
   logged via `console.error` (visible in observability) and returned as a generic 500.

## Two planes: auth vs data

The worker has two clearly separated planes:

- **Auth plane** (stateful, infrequent, expensive): challenge issuance, App Attest
  verification, StoreKit/promo entitlement, JWT minting. Writes to D1 (`devices`),
  reads KV. Rate-limited. Runs at most once per session (plus once per snapshot).
- **Data plane** (stateless, frequent, cheap): version/manifest/rows/snapshot. Gated by
  the JWT only (except snapshot). Served from the edge cache. This is what 1000 users hit
  repeatedly, and it almost never reaches D1.

Keeping these separate is what lets the data plane scale: the costly cryptographic work
happens once at session creation, and the steady-state sync traffic is just cached reads.

## Why a separate worker from the write worker

The [write worker](../../worker) is a trusted, HMAC-authenticated endpoint used by exactly
one client (the Python sync script). The read worker is public, faces thousands of
devices, and uses completely different auth. Keeping them as separate Workers means:

- **Least privilege** — the public worker is read-only against D1.
- **Independent deploys** — changing read auth never risks the write path.
- **Different threat models** — HMAC-with-shared-secret (one trusted client) vs
  App Attest + entitlement (many untrusted clients) stay isolated.

Both bind the **same** D1 database; the write worker mutates it, the read worker only
selects from it.

## Free vs full tiers

A `free` boolean column on each table marks the curated preview set (the free 100-word
tier). The session JWT carries a `scope` claim (`free` | `full`), and **every** data
query is filtered by it ([`scopeWhere` in src/data.ts](../src/data.ts)). A free session
literally cannot see — or fetch by id — anything outside the preview. This is the
server-side paywall; see [sync-protocol.md](sync-protocol.md#tiers) and
[authentication.md](authentication.md#entitlement--scope).

## Scaling characteristics

- **Reads scale with the edge cache, not D1.** Per dataset version, each Cloudflare PoP
  queries D1 about once per endpoint, then serves everyone else from cache.
- **D1 writes** happen only on the auth plane: `devices` upsert on register, and a
  `sign_count` update per session / per snapshot assertion. These are low-frequency.
- **Memory** — the snapshot is built as a single NDJSON string per cache-miss. For a few
  thousand words this is small; if it ever grows large, move snapshots to R2 with range
  requests (documented but not yet wired).
