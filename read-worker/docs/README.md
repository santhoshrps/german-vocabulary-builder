# Read Worker — Documentation

How the read/sync worker serves the German vocabulary dataset to the iOS app.

This worker is **read-only** against the same Cloudflare D1 database that the
[write worker](../../worker) fills from Excel via the [sync script](../../sync). It is
built to serve **100–1000 concurrent users** reading the **same shared dataset**, with
strong per-device authorization and a free/full content split.

## Contents

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | The big picture: components, request lifecycle, why it's shaped this way |
| [authentication.md](authentication.md) | App Attest, StoreKit entitlement, promo codes, the session JWT, and the per-request assertion gate |
| [sync-protocol.md](sync-protocol.md) | How a client syncs: version → manifest → rows / snapshot, deltas, and free vs full tiers |
| [caching.md](caching.md) | Edge caching keyed on dataset version, ETags, and how D1 stays off the hot path |
| [api-reference.md](api-reference.md) | Every endpoint: method, auth, parameters, responses |
| [promo-codes.md](promo-codes.md) | Promo codes & access tiers (free/full): model, verification, registration, troubleshooting |

## One-paragraph summary

A device proves it is a genuine copy of your app (**App Attest**) and that it is
entitled to read (**StoreKit purchase** or a **promo code**). On success the worker
issues a short-lived **session JWT** carrying a `scope` of `free` or `full`. The client
then syncs by polling a tiny **version** value, pulling a **manifest** of
`{id: content_hash}` to diff against its local copy, and fetching only the changed
**rows** (or a full **snapshot** on first run). Every data response is served from an
**edge cache keyed on the dataset version**, so the underlying D1 database is queried
roughly once per version per Cloudflare location rather than once per user.

## Source map

| File | Role | Doc |
|------|------|-----|
| `src/index.ts` | Router + endpoint handlers | [api-reference](api-reference.md) |
| `src/appattest.ts` | App Attest attestation + assertion | [authentication](authentication.md) |
| `src/entitlement.ts` | StoreKit JWS + promo codes + scope | [authentication](authentication.md) |
| `src/jwt.ts` | Session token sign/verify | [authentication](authentication.md) |
| `src/kv.ts` | Challenge nonces + rate limiting | [authentication](authentication.md) |
| `src/cache.ts` | Edge cache by version | [caching](caching.md) |
| `src/data.ts` | Version, manifest, rows, snapshot (scoped) | [sync-protocol](sync-protocol.md) |
| `src/crypto/{cbor,der}.ts` | CBOR + DER/X.509 parsing | [authentication](authentication.md) |

For setup, deployment, and the curl self-test, see the [read-worker README](../README.md).
