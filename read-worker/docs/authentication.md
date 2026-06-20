# Authentication & Authorization

The worker answers two questions before serving any data:

1. **Is this a genuine copy of our app?** → App Attest
2. **Is this device entitled to read, and how much?** → StoreKit purchase or promo code

On success it issues a **session JWT** that carries the answer to both, so the expensive
checks run once per session instead of once per request.

```
GET  /v1/challenge ──────▶ server nonce
POST /v1/devices/register ─ App Attest attestation ──▶ store device public key
POST /v1/session ────────── assertion + entitlement ─▶ session JWT { scope }
                                                          │
GET  /v1/version|manifest|rows  ── Bearer JWT ───────────┘
GET  /v1/snapshot               ── Bearer JWT + fresh assertion
```

---

## 1. App Attest — "genuine app"

App Attest ([`src/appattest.ts`](../src/appattest.ts)) uses a hardware key in the device's
Secure Enclave that Apple vouches for. It has two operations.

### Attestation (once per install) — `POST /v1/devices/register`
The app generates a key, attests it with Apple, and sends the attestation object. The
worker verifies, in order:

1. **fmt** is `apple-appattest`.
2. **nonce** — `SHA256(authData ‖ SHA256(challenge))` equals the value in the cert's
   App Attest extension (OID `1.2.840.113635.100.8.2`). Binds the attestation to *our*
   fresh challenge.
3. **certificate chain** links up to the pinned **Apple App Attest Root CA**
   (`APPLE_APPATTEST_ROOT_CA`).
4. **app id** — `rpIdHash` equals `SHA256("<APP_TEAM_ID>.<APP_BUNDLE_ID>")`.
5. **environment** — the AAGUID matches `APP_ATTEST_ENV` (`production` / `development`).
6. **key id** — `SHA256(publicKey)` equals both the `credentialId` in `authData` and the
   client-supplied `keyId`.

The device's public key + initial counter are stored in the `devices` table. The
`device_id` is the base64url key id.

### Assertion (per protected action) — used by `/v1/session` and `/v1/snapshot`
The app signs a fresh challenge with its stored key. The worker verifies:

1. The ECDSA signature over `SHA256(authenticatorData ‖ SHA256(challenge))` against the
   **stored** public key.
2. `rpIdHash` again equals the app id hash.
3. The **counter strictly increased** versus the stored value — catches cloned keys —
   and the new counter is persisted.

### The three non-negotiables (and where they live)

| Requirement | Implementation |
|-------------|----------------|
| **Server-generated, single-use challenge** | `issueChallenge` mints a random 32-byte nonce in KV; `consumeChallenge` reads **and deletes** it ([`src/kv.ts`](../src/kv.ts)). |
| **Server-side verification** | All checks run in the worker against the stored key; the client's claims are never trusted ([`verifyAssertion`](../src/appattest.ts)). |
| **Counter increments** | `signCount <= storedSignCount → reject`, then persisted ([`src/appattest.ts`](../src/appattest.ts)). |

> ⚠️ The CBOR/DER/X.509 verification is hand-rolled ([`src/crypto/`](../src/crypto)). Validate
> it against Apple's published App Attest test vectors before trusting it in production.

---

## 2. Entitlement & scope

Two ways to prove a device may read, both in [`src/entitlement.ts`](../src/entitlement.ts).
Each yields an `Entitlement { type, scope, label }` where `scope` is `free` or `full`.

### StoreKit 2 (production paid path)
A signed transaction (JWS) from the App Store. The worker:

1. Verifies the JWS cert chain to the pinned **Apple Root CA – G3** (`APPLE_STOREKIT_ROOT_CA`).
2. Verifies the ES256 signature with the leaf cert's key.
3. Checks `bundleId` matches, `productId` is in `ENTITLEMENT_PRODUCT_IDS`, and the
   transaction is not expired/revoked.

A valid purchase always grants **`scope: "full"`**.

### Promo codes (self-test & manual grants)
A shared secret checked against the `promo_codes` table by `SHA256(code)` (the code itself
is never stored). The row's `tier` column sets the scope:

- `tier = "full"` → full access (an alternative to a StoreKit purchase)
- anything else → `free` (least privilege; this is the default)

Promo codes also honor `active` and `expires_at`. **Promo is enabled in production by
design** — keep codes scoped and expiring, since a `full` code grants the entire dataset
without a device.

---

## 3. Session JWT

After verification, [`signSession`](../src/jwt.ts) issues an HS256 JWT signed with
`SESSION_JWT_SECRET`:

```json
{ "sub": "<device_id | promo:label>", "ent": "storekit|promo",
  "scope": "free|full", "iat": <now>, "exp": <now + SESSION_TTL_SECONDS> }
```

- Symmetric HS256 is fine because the same worker signs and verifies.
- `scope` is the authorization decision, carried so every data request can filter by it
  without re-checking the entitlement.
- TTL is `SESSION_TTL_SECONDS` (default 3600). **Shorten it** (e.g. 900) to shrink the
  window a stolen token is usable; re-minting just costs one assertion.

Data endpoints call `requireSession` ([`src/index.ts`](../src/index.ts)) which verifies the
signature and expiry, then `scopeOf` maps an unknown/missing scope to `free`
(fail-closed).

---

## 4. Per-request assertion on `/v1/snapshot`

The full-dataset download is the one thing worth stealing, so a session JWT alone is **not
enough** for device sessions. `requireFreshAssertion` ([`src/index.ts`](../src/index.ts))
requires, on **every** snapshot request:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <session JWT>` |
| `X-Challenge` | a nonce just fetched from `GET /v1/challenge` |
| `X-Assertion` | base64 App Attest assertion signing that challenge |

It consumes the challenge, verifies the assertion against the device's stored key, and
checks the counter — so the bulk export can't be pulled with a stolen token. The NDJSON
**body is still served from the version cache**; only the access check runs per request.

**Promo sessions are exempt** (no device key) — they get the snapshot with the JWT alone.
That is the deliberate trade for keeping promo usable as an operator/test credential.

---

## Threat model summary

| Threat | Defense |
|--------|---------|
| Scraper / non-app client | App Attest (no genuine key → can't register or assert) |
| Replayed captured request | Single-use server challenges (deleted on use) |
| Cloned device key | Strictly increasing assertion counter |
| Forged purchase | StoreKit JWS verified + pinned to Apple Root CA – G3 |
| Forged session token | HS256 signature over `SESSION_JWT_SECRET` |
| Stolen session token | Short TTL; **full snapshot additionally needs a fresh assertion** |
| Free user reaching paid rows | Server-side `scope` filter on every query (`free = 1`) |
| Auth endpoint abuse | Per-IP rate limiting on `challenge`/`session`/`devices` |
