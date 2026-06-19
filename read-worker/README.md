# Read / Sync Worker (iOS clients)

Serves the German vocabulary dataset to the iOS app for offline sync. Read-only
against the same D1 database the write worker fills from Excel.

Designed for **100–1000 concurrent users** reading the **same shared dataset**, so
the architecture leans entirely on edge caching: a request is authenticated, then
served from a per-dataset-version cached object. D1 is hit roughly **once per
version per Cloudflare PoP**, not once per user.

## Security model (no user login, paid/gated content)

Two layers, combined into a short-lived session token:

1. **App Attest** — proves the request comes from a genuine, unmodified build of
   your app on a real Apple device. Stops scrapers and tampered clients.
2. **Entitlement** — proves the device is allowed to read:
   - **StoreKit 2** signed transaction (the paid path), or
   - **Promo code** (the self-test path — works now, before the iOS app exists).

After verification, the worker issues a **session JWT** (default 1h). All data
endpoints take that JWT as a `Bearer` token, so the expensive App Attest/StoreKit
checks run once per session, not per request.

> ⚠️ The App Attest and StoreKit JWS verifiers ([src/appattest.ts](src/appattest.ts),
> [src/entitlement.ts](src/entitlement.ts)) implement Apple's documented algorithms with
> hand-rolled CBOR/DER + WebCrypto. **Validate them against Apple's published test
> vectors before production**, and set the pinned Apple roots (`APPLE_APPATTEST_ROOT_CA`,
> `APPLE_STOREKIT_ROOT_CA`). The promo path needs none of this and is safe to use immediately.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/v1/challenge` | none (rate-limited) | One-time nonce for App Attest attestation/assertion |
| `POST` | `/v1/devices/register` | App Attest attestation | Register a device's attested key. Body: `{keyId, attestationObject, challenge}` |
| `POST` | `/v1/session` | promo **or** assertion+StoreKit | Mint a session JWT (see below) |
| `GET` | `/v1/version` | Bearer JWT | Current dataset version (cheap poll) |
| `GET` | `/v1/manifest` | Bearer JWT | `{table:{id:content_hash}}` for delta reconciliation |
| `GET` | `/v1/rows/:table?ids=a,b,c` | Bearer JWT | Full rows for changed ids (≤200/request) |
| `GET` | `/v1/snapshot` | Bearer JWT **+ fresh assertion** | Full dataset as NDJSON (first-time/full sync) |

### Per-request assertion on `/v1/snapshot`
The bulk download is the one thing worth stealing, so a session JWT alone is **not**
enough for device (StoreKit) sessions — each `/v1/snapshot` request must also carry a
**fresh, single-use App Attest assertion**:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <session JWT>` |
| `X-Challenge` | a nonce just fetched from `GET /v1/challenge` |
| `X-Assertion` | base64 App Attest assertion signing that challenge |

The Worker consumes the challenge, verifies the assertion against the device's stored
key, and checks the counter increments — so the full dataset can't be pulled with a
stolen token. The NDJSON **body is still served from the version cache**, so the
expensive payload stays cacheable; only the access check runs per request.

**Promo sessions are exempt** (they have no device key) — they download the snapshot
with the JWT alone. Promo codes are a privileged operator credential: scope and expire
them tightly, since one grants full snapshot access without a device.

### `POST /v1/session`
- **Promo (self-test):** `{ "promoCode": "LET-ME-IN" }`
- **Production:** `{ "deviceId", "assertion", "challenge", "signedTransaction" }`

Returns `{ token, expiresIn, entitlement }`.

## Client sync flow

1. `GET /v1/version` → if unchanged from the local copy, stop.
2. `GET /v1/manifest` → diff `{id: content_hash}` against the local store:
   - id missing locally → fetch; hash differs → fetch; id gone from manifest → delete.
3. `GET /v1/rows/:table?ids=…` for changed ids (loop in ≤200 batches), **or**
   `GET /v1/snapshot` for a first-time full pull (fetch a fresh `/v1/challenge` and
   attach `X-Challenge` + `X-Assertion` — see "Per-request assertion" above).
4. Apply in a local SQLite transaction; save the new version.

`ETag`/`If-None-Match` returns **304** when the client is already current, and the
manifest/snapshot are edge-cached, so steady-state sync transfers almost nothing.

## Setup

```bash
# 1. Apply the extra tables to the SAME D1 database
wrangler d1 execute german-vocabulary --file=read-worker/schema/extra.sql

# 2. Create a KV namespace (challenges + rate limits) and paste its id into wrangler.toml
wrangler kv namespace create KV

# 3. Set secrets
openssl rand -hex 32 | wrangler secret put SESSION_JWT_SECRET   # paste when prompted
wrangler secret put APPLE_APPATTEST_ROOT_CA   # base64 DER of Apple App Attest Root CA
wrangler secret put APPLE_STOREKIT_ROOT_CA    # base64 DER of Apple Root CA - G3

# 4. Set APP_TEAM_ID / APP_BUNDLE_ID / ENTITLEMENT_PRODUCT_IDS in wrangler.toml [vars]

# 5. Deploy
cd read-worker && npm install && npm run deploy
```

## Self-test with curl (no iOS app needed)

```bash
# Register a promo code
printf 'LET-ME-IN' | shasum -a 256          # → <hash>
wrangler d1 execute german-vocabulary \
  --command "INSERT INTO promo_codes (code_hash, label) VALUES ('<hash>', 'self-test')"

BASE=https://german-vocabulary-read-worker.<subdomain>.workers.dev

# 1. Mint a session via promo
TOKEN=$(curl -s -X POST $BASE/v1/session \
  -H 'Content-Type: application/json' \
  -d '{"promoCode":"LET-ME-IN"}' | jq -r .token)

# 2. Use it
curl -s $BASE/v1/version  -H "Authorization: Bearer $TOKEN"
curl -s $BASE/v1/manifest -H "Authorization: Bearer $TOKEN"
curl -s $BASE/v1/snapshot -H "Authorization: Bearer $TOKEN"
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Router + all endpoints |
| `src/env.ts` | Bindings & vars interface |
| `src/bytes.ts` | base64/hex/sha256/concat helpers |
| `src/http.ts` | JSON/error helpers, bearer + IP extraction |
| `src/jwt.ts` | HS256 session token sign/verify |
| `src/kv.ts` | Challenge nonces + rate limiting (KV) |
| `src/cache.ts` | Edge cache keyed on dataset version (token excluded) |
| `src/crypto/cbor.ts` | Minimal CBOR decoder (App Attest) |
| `src/crypto/der.ts` | Minimal DER/ASN.1 reader (X.509 cert handling) |
| `src/appattest.ts` | App Attest attestation + assertion verification |
| `src/entitlement.ts` | StoreKit 2 JWS verification + promo code |
| `src/data.ts` | Version, manifest, rows, snapshot from D1 |
| `schema/extra.sql` | `meta`, `devices`, `promo_codes` tables |






### How to get Apple root CS certificates?

Both come from Apple's public Certificate Authority page (https://www.apple.com/certificateauthority/). They're public certificates — downloading over HTTPS from apple.com is what makes them authentic. Your worker expects them as base64-encoded DER, which is what these commands produce.

1. APPLE_APPATTEST_ROOT_CA — "Apple App Attestation Root CA"
Apple publishes this one as a PEM. Download, convert to DER, base64-encode, and pipe straight into wrangler:


curl -sO https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem

openssl x509 -in Apple_App_Attestation_Root_CA.pem -outform DER \
  | base64 | tr -d '\n' \
  | wrangler secret put APPLE_APPATTEST_ROOT_CA
2. APPLE_STOREKIT_ROOT_CA — "Apple Root CA - G3"
This one is distributed as a DER .cer already. Re-encode through openssl (normalizes it) and pipe in:


curl -sO https://www.apple.com/certificateauthority/AppleRootCA-G3.cer

openssl x509 -inform DER -in AppleRootCA-G3.cer -outform DER \
  | base64 | tr -d '\n' \
  | wrangler secret put APPLE_STOREKIT_ROOT_CA
wrangler secret put reads the piped stdin, so you won't be prompted — the base64 string is set directly.