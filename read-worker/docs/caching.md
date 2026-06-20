# Caching

Caching is what lets this worker serve 100–1000 concurrent users while keeping D1 almost
idle. The whole strategy rests on one property: **the dataset is identical for every user
at a given version and scope**, so one cached object can serve everyone.

## The core idea

After a request is authenticated, the data is served from the Cloudflare **Cache API**,
keyed on the **dataset version** — *not* on the caller's token. Implementation:
[`serveCachedByVersion` in src/cache.ts](../src/cache.ts).

```
request ──▶ verify JWT ──▶ build cache key from (path + version + scope)   ← token excluded
                                   │
                          cache.match(key)
                          ╱            ╲
                      HIT               MISS
                  serve cached      query D1, build body,
                  (X-Cache: HIT)    cache.put(), serve (X-Cache: MISS)
```

Because the cache key excludes the `Authorization` header, **all authorized users share
the same cached entry**. D1 is queried roughly **once per (version, scope, endpoint) per
Cloudflare PoP**, then everyone else at that PoP is served from cache until the version
changes.

Auth still happens on every request — it runs *before* the cache lookup, so an
unauthorized request never receives a cached body. Caching accelerates the *data*, it
does not bypass the *gate*.

## Cache key

The synthetic key is built from the path plus a version+tag query, e.g.:

```
https://read-cache.internal/v1/manifest?v=<version>&tag=manifest:free
```

- `v=<version>` — the scoped dataset version. A new version ⇒ a new key ⇒ automatic
  invalidation (old entries simply age out, never served).
- `tag` — distinguishes endpoints and scopes that share a path shape, e.g.
  `manifest:free` vs `manifest:full`, or `rows:full:verbs:<sorted ids>`.

There is **no manual purge**: correctness comes from the version being part of the key.
When the data changes, the version changes, and all clients move to fresh keys.

## ETags and 304

Every cached response carries `ETag: "<version>"`. A client that already holds the current
version sends `If-None-Match: "<version>"` and gets **`304 Not Modified`** with no body
([`serveCachedByVersion`](../src/cache.ts) checks this first). This is the cheapest
possible "are we current?" — most steady-state syncs end here or at `/v1/version`.

## Per-endpoint cache policy

| Endpoint | `max-age` | Notes |
|----------|-----------|-------|
| `GET /v1/version` | 30s | Tiny; short TTL so clients notice new versions quickly. Not stored via the Cache API — just `Cache-Control` + `ETag`. |
| `GET /v1/manifest` | 300s | Version-keyed; one object per (version, scope). |
| `GET /v1/rows/:table` | 300s | Keyed by (version, scope, table, sorted ids). |
| `GET /v1/snapshot` | 86400s | Effectively immutable per version; long TTL. Access still gated by a fresh assertion for device sessions, but the **body** comes from cache. |

`version` deliberately has a short TTL so a client polling it picks up a new dataset within
~30s; the heavier endpoints can cache for much longer because their key already changes
when the version does.

## Snapshot: gated access, cached body

`/v1/snapshot` is the interesting case. For device sessions it requires a fresh App Attest
assertion **on every request** — but that assertion gates *access*, not the *body*. After
the assertion passes, the NDJSON is served from the version cache. So:

- the expensive payload is built from D1 at most once per version per PoP, and
- a stolen token still can't pull it, because the assertion runs first.

This is why the per-request assertion doesn't wreck snapshot scalability.

## What is *not* cached

- Auth endpoints (`challenge`, `devices/register`, `session`) — they are per-request by
  nature (fresh nonces, signature checks, D1 writes) and must never be cached.
- Error responses.

## Interaction with the version derivation

The version ([`getVersion`](../src/data.ts)) reflects inserts, updates, and deletes (via
`COUNT(*)` + `MAX(updated_at)`), and is scope-specific. Because the cache key embeds this
version, the cache is **self-invalidating**: there is no scenario where stale data is
served, short of the ~30s `version` TTL window during which a client might not yet know a
new version exists. Once it fetches the new version, every downstream key changes with it.

## Scaling math (intuition)

With `N` users at one PoP and a version that changes `k` times/day:

- Manifest/snapshot D1 queries ≈ `k` per PoP per scope (not `N`).
- The other `N − 1` users per cache window are served from the edge.

So D1 load scales with **how often the data changes**, not with **how many users read it**
— which is exactly right for a dataset that updates only when the Excel sync runs.
