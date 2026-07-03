# Promo Codes & Access Tiers

How the German Vocabulary app gates content with promo codes, how the two access
tiers work, and how to register, test, and troubleshoot codes.

---

## 1. Overview

The app uses **promo codes** to decide how much of the vocabulary dataset a user
can download. There are two access tiers:

| Tier   | What it unlocks                          | How a user gets it |
|--------|------------------------------------------|--------------------|
| `free` | The curated **100-word preview** (rows flagged `free = 1`) | The **built-in** code, shipped in the app — every user has it automatically |
| `full` | The **entire dataset**                   | A **StoreKit purchase** (not yet implemented) **or** a `tier = 'full'` promo code the user enters |

The limit is enforced **on the server**, not in the app. A `free` session
literally cannot fetch beyond the 100 preview words — the worker filters every
query by the session's scope. Hiding rows client-side would be pointless because
the data would already be on the device.

> StoreKit and App Attest are deferred. Today, full access is granted **only** by
> a `tier = 'full'` promo code.

---

## 2. Data model

Promo codes live in the `promo_codes` table in D1 (defined in
[`schema/extra.sql`](../schema/extra.sql)):

```sql
CREATE TABLE promo_codes (
  code_hash  TEXT PRIMARY KEY,   -- sha256(code) as lowercase hex
  label      TEXT,               -- human label for audit (appears in the JWT subject)
  tier       TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'full'
  active     INTEGER NOT NULL DEFAULT 1,    -- 0 disables the code
  expires_at TEXT                -- ISO-8601 UTC, or NULL for no expiry
);
```

Key points:

- **Only the SHA-256 hash of the code is stored** — never the plaintext. The
  worker can verify a code but cannot recover it (and neither can anyone reading
  the database).
- `tier` **defaults to `'free'`** (least privilege). A code only grants full
  access if you set `tier = 'full'` explicitly.
- The free 100-word set is defined separately, by a `free = 1` flag on rows in
  the `verbs`, `nouns`, and `adverbs_adjectives` tables (see
  [`../../schema/init.sql`](../../schema/init.sql) and the
  [`add_free_tier.sql`](../../schema/add_free_tier.sql) migration).

---

## 3. How verification works

When the app calls `POST /v1/session` with `{ "promoCode": "<plaintext>" }`, the
worker ([`src/entitlement.ts`](../src/entitlement.ts) → `verifyPromoCode`):

1. Computes `sha256(code)` as lowercase hex.
2. Looks up the row by `code_hash`.
3. Rejects if the row is missing, `active = 0`, or past `expires_at`.
4. Maps the tier to a **scope**: `tier = 'full'` → `full`, anything else → `free`.

It then mints a short-lived **session JWT** ([`src/jwt.ts`](../src/jwt.ts)) that
carries a `scope` claim, and returns:

```json
{ "token": "<jwt>", "expiresIn": 3600, "entitlement": "promo", "scope": "full" }
```

Every data endpoint (`/v1/version`, `/v1/manifest`, `/v1/rows`, `/v1/snapshot`)
reads the scope from the JWT and filters its D1 queries accordingly
([`src/data.ts`](../src/data.ts)): `free` sessions add `WHERE free = 1`, `full`
sessions see everything.

The dataset **version is scope-qualified** (`getVersion(env, scope)`), so when a
user upgrades free → full the version/ETag changes, the client's "am I current?"
check fails, and it re-syncs to pick up the rest of the dataset automatically.

---

## 4. The full flow

```
┌─────────┐   POST /v1/session {promoCode}    ┌──────────────┐
│  iOS    │ ────────────────────────────────► │ read-worker  │
│  app    │                                    │              │
│         │   { token, scope: "free"|"full" }  │ verifyPromo  │──► D1 promo_codes
│         │ ◄──────────────────────────────────│   Code       │    (hash, tier)
│         │                                    │              │
│         │   GET /v1/version  (Bearer token)  │ scope from   │
│         │ ────────────────────────────────► │   JWT claim  │
│         │   GET /v1/manifest / rows / snapshot               │
│         │ ◄──────────────────────────────────│ filtered by  │──► D1 verbs/nouns/…
│         │   only in-scope rows               │ WHERE free=1 │    (free flag)
└─────────┘                                    └──────────────┘
```

---

## 5. App behaviour

| Concern | Where | Notes |
|---------|-------|-------|
| Built-in free code | `VocabularySyncConfig.freePromoCode` | Ships in the binary. Safe — it only unlocks 100 words. |
| User's full code | `EntitlementStore` | Persisted in `UserDefaults`; survives restarts, removed on uninstall, not synced across devices. |
| Which code is used | `EntitlementStore.activePromoCode` | The user's full code if present, otherwise the free code. |
| Entering a full code | `UnlockFullAccessView` | Reachable from the skippable post-onboarding sheet **and** Settings → "Full Access". |
| Redeeming | `EntitlementStore.redeemFullAccessCode` | Saves the code, re-syncs, and verifies the server actually granted `full`. If not, it drops the code and reverts to free. |

So a user enters a full code **once**; it's remembered and re-used on every sync.
If the server later rejects it (revoked/expired), the redeem path falls back to
free — though a *background* sync currently just fails silently and keeps cached
data (see TODOs).

---

## 6. Registering codes

Run from the `read-worker` directory. **`--remote` is required** — without it you
edit the local dev database, not the deployed worker's D1.

### Free (built-in) code

The plaintext must match `VocabularySyncConfig.freePromoCode` in the app.

```bash
HASH=$(printf '%s' 'flashcard-dev-2026' | shasum -a 256 | awk '{print $1}')
wrangler d1 execute german-vocabulary --remote \
  --command "INSERT INTO promo_codes (code_hash, label, tier) VALUES ('$HASH', 'builtin-free', 'free')"
```

### Full-access code

Pick a code, hand it out individually. It is **not** in the app.

```bash
FULL_CODE='premium-2026-DFTAXY'
HASH=$(printf '%s' "$FULL_CODE" | shasum -a 256 | awk '{print $1}')
wrangler d1 execute german-vocabulary --remote \
  --command "INSERT INTO promo_codes (code_hash, label, tier) VALUES ('$HASH', 'full-grant', 'full')"
```

Optional expiry (ISO-8601 UTC):

```bash
wrangler d1 execute german-vocabulary --remote \
  --command "INSERT INTO promo_codes (code_hash, label, tier, expires_at) VALUES ('$HASH', 'beta-tester', 'full', '2026-12-31T00:00:00Z')"
```

> **Use `printf '%s'`, not `echo`** — `echo` appends a newline and you'd hash the
> wrong bytes. `shasum -a 256` outputs lowercase hex, matching the worker's
> `bytesToHex(sha256(code))`.

### Verify

```bash
wrangler d1 execute german-vocabulary --remote \
  --command "SELECT label, tier, active, expires_at FROM promo_codes"
```

### Test end-to-end (no app needed)

```bash
BASE=https://german-vocabulary-read-worker.<subdomain>.workers.dev
curl -s -X POST $BASE/v1/session -H 'Content-Type: application/json' \
  -d '{"promoCode":"premium-2026-DFTAXY"}'
# expect: {"token":...,"entitlement":"promo","scope":"full"}
```

If the response has **no `scope` field**, the deployed worker is out of date —
redeploy it (see Troubleshooting).

---

## 7. Operating codes

| Action | Command |
|--------|---------|
| Disable a code | `UPDATE promo_codes SET active = 0 WHERE label = 'full-grant'` |
| Re-enable | `UPDATE promo_codes SET active = 1 WHERE label = 'full-grant'` |
| Expire now | `UPDATE promo_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE label = '…'` |
| Delete | `DELETE FROM promo_codes WHERE label = '…'` |

(Run each with `wrangler d1 execute german-vocabulary --remote --command "…"`.)

Revoking a code stops it minting **new** sessions immediately. Sessions already
issued remain valid until the JWT expires (default 1 hour, `SESSION_TTL_SECONDS`).

---

## 8. Security notes

- **The free code is public** (it ships in the app binary). That's acceptable —
  it only unlocks the 100-word preview.
- **Full codes are secrets.** Store only their hashes, hand them out
  individually, and scope/expire them. One full code grants the entire dataset.
- The free tier's 100 words are whatever you mark `free = 1`. If you mark
  **zero** rows, free users sync **nothing**.
- App-side, the user's full code is currently in `UserDefaults`. Moving it to the
  **Keychain** (encrypted, optionally iCloud-synced across devices) is a planned
  hardening step.

### Abuse prevention (rate limiting & cooldown)

Code redemption is guessing-resistant on several layers:

- **Server rate limit (authoritative).** The worker caps `/v1/session` at
  **10 requests per 60 seconds per IP** (`challenge` 30/min, `devices/register`
  10/10min — `authBudget` in [`src/index.ts`](../src/index.ts)); excess requests
  get `429`. Counters are atomic D1 upserts, so concurrent requests can't slip
  past the bound. This is the real protection, since it applies even to scripted
  clients that bypass the app.
- **One session mint per attempt.** A failed redeem performs a single
  `/v1/session` call — no wasteful "revert" re-sync — so legitimate retries stay
  well under the limit (`EntitlementStore.redeemFullAccessCode`).
- **Client-side cooldown.** After **3 consecutive failed attempts**, the app
  disables the Redeem button for **30 seconds** with a live countdown, so users
  hit a clear message instead of an opaque `429`
  (`UnlockFullAccessView` → `AccessCodeEntryView`). It's a UX guard, not the
  security boundary — the server limit is. Constants:
  `maxAttemptsBeforeCooldown`, `cooldownSeconds`.
- **Input hardening.** The code field accepts only `A–Z a–z 0–9 - _`, capped at
  **64 characters** — no unbounded paste, control characters, or odd input
  reaches the request.
- **Hashes only.** Codes are stored as `sha256` hashes; a database leak doesn't
  expose usable codes. Sessions issued before a code is revoked stay valid until
  the JWT expires (`SESSION_TTL_SECONDS`, default 1h).

---

## 9. Troubleshooting

**A valid full code shows "invalid code" in the app.**
Almost always: the **deployed worker is older than the code changes**. Check the
session response — if it has no `scope` field, the live worker predates tiers.
The app reads `scope`; with none, it defaults to `free`, so the redeem flow
treats the (otherwise valid) code as a failure. Fix: redeploy the worker.

```bash
cd read-worker && npm install && npm run deploy   # or: npx wrangler deploy
```

**`verifyPromoCode` errors / 500 on session.**
The `tier` column is missing. Apply the migration:
```bash
wrangler d1 execute german-vocabulary --remote --file=../schema/add_free_tier.sql
```
(If `tier` already exists but the vocab tables lack `free`, add just the `free`
columns — `ALTER TABLE` has no `IF NOT EXISTS`, so check with
`PRAGMA table_info(nouns)` first.)

**Code is rejected (403 "invalid promo code").**
- Hash mismatch — you used `echo` instead of `printf '%s'`, or there's stray
  whitespace. Recompute and compare to the stored `code_hash`.
- The row is `active = 0` or past `expires_at`.
- You inserted into the local DB (forgot `--remote`).

**Free users get 0 words after deploy.**
No rows are flagged `free = 1`. Mark your preview set, e.g.
`UPDATE nouns SET free = 1 WHERE level = 'A1'` (and the other tables).

**A user can't return to the unlock screen.**
After onboarding the prompt is skippable; the persistent entry point is
**Settings → Full Access**.

---

## 10. Where the code lives

| Piece | File |
|-------|------|
| Promo verification, tier → scope | `read-worker/src/entitlement.ts` |
| Session JWT (scope claim) | `read-worker/src/jwt.ts` |
| Scope-filtered queries, scoped version | `read-worker/src/data.ts` |
| Router, session response, scope threading | `read-worker/src/index.ts` |
| `promo_codes` schema | `read-worker/schema/extra.sql` |
| `free` flag + `tier` migration | `schema/init.sql`, `schema/add_free_tier.sql` |
| Builder `Free` column → D1 | `sync/sync.py`, `worker/src/index.ts` |
| App: built-in free code | `flashcard-german/Sync/VocabularySyncConfig.swift` |
| App: tier state, persistence, redeem | `flashcard-german/Sync/EntitlementStore.swift` |
| App: code entry UI | `flashcard-german/UnlockFullAccessView.swift` |
