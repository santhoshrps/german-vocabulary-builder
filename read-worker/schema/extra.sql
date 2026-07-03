-- Additional tables used by the read worker. Apply to the SAME D1 database:
--   wrangler d1 execute german-vocabulary --file=read-worker/schema/extra.sql

-- Optional explicit dataset version. If absent, the read worker derives a version
-- from per-table COUNT(*) + MAX(updated_at) (which also reflects deletions).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- App Attest device registry: one row per attested device key.
CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,                       -- App Attest keyId (base64url of SHA256(pubkey))
  public_key TEXT NOT NULL,                          -- base64 SPKI DER of the attested P-256 key
  sign_count INTEGER NOT NULL DEFAULT 0,             -- last seen assertion counter (anti-replay/clone)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

-- Promo codes for self-testing without an iOS build or a StoreKit purchase.
-- Store only the SHA-256 (hex) of each code, never the code itself.
-- `tier` controls how much of the dataset a code unlocks:
--   'free' -> only the curated 200-word preview (rows with free = 1)
--   'full' -> the entire dataset
-- Default is 'free' (least privilege) — grant full access explicitly.
CREATE TABLE IF NOT EXISTS promo_codes (
  code_hash  TEXT PRIMARY KEY,                       -- sha256(code) hex
  label      TEXT,
  tier       TEXT NOT NULL DEFAULT 'free',           -- 'free' | 'full'
  active     INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT                                    -- ISO8601 or NULL for no expiry
);

-- User-submitted words awaiting curation. Inserted by POST /v1/submissions when a
-- searched word isn't found locally or in the backend. NEVER published automatically —
-- a curator reviews these and (if accepted) adds them to the vocabulary tables in a
-- later update. `source` is the requesting session subject (device id or promo label),
-- kept for rate-limiting / abuse review, not personal data.
CREATE TABLE IF NOT EXISTS submissions (
  id         TEXT PRIMARY KEY,                       -- random uuid
  word       TEXT NOT NULL,                          -- the German word the user typed
  type       TEXT,                                   -- optional: 'noun' | 'verb' | 'adjective' | 'adverb'
  source     TEXT,                                   -- session subject (e.g. 'promo:label' or device id)
  scope      TEXT,                                   -- caller scope at submit time ('free' | 'full')
  status     TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'approved' | 'rejected'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);

-- Per-device count of search REQUESTS a free user has made. A free (attested) device
-- may run up to a fixed cap of searches before being asked to upgrade; within the cap,
-- searches return full results (including paid-word previews). Keyed to device_id (App
-- Attest keyId), so the cap survives an app reinstall — it is NOT resettable local state.
-- Enforced only when APP_ATTEST_ENV="production" (the dev worker is exempt for testing).
CREATE TABLE IF NOT EXISTS search_usage (
  device_id     TEXT PRIMARY KEY,                     -- devices.device_id
  request_count INTEGER NOT NULL DEFAULT 0,           -- lifetime search requests from this device
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Example: the app's built-in free-tier code (200-word preview):
--   printf 'flashcard-free-2026' | shasum -a 256
--   INSERT INTO promo_codes (code_hash, label, tier) VALUES ('<hash>', 'builtin-free', 'free');
-- A full-access code (alternative to a StoreKit purchase):
--   printf 'SOME-FULL-CODE' | shasum -a 256
--   INSERT INTO promo_codes (code_hash, label, tier) VALUES ('<hash>', 'full-grant', 'full');

-- One-time App Attest challenges (nonces). Consumed by a single conditional DELETE
-- (src/limits.ts) — atomic in SQLite, so a challenge can never be consumed twice, which the
-- earlier KV get→delete allowed under concurrency (TOCTOU). Expired rows are GC'd
-- opportunistically on issue.
CREATE TABLE IF NOT EXISTS challenges (
  challenge  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL                        -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges (expires_at);

-- Fixed-window rate-limit counters, incremented by an atomic upsert (src/limits.ts) that
-- returns the post-increment count — a hard bound under concurrency, unlike the earlier
-- non-atomic KV read-modify-write. Dead windows are GC'd on the first hit of a new window.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,                       -- "<name>:<subject>:<window-number>"
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL                        -- unix seconds (window end + grace)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits (expires_at);

-- Devices bound to a StoreKit purchase (by originalTransactionId). One signed transaction may
-- mint sessions for at most TRANSACTION_DEVICE_CAP distinct attested devices (src/index.ts) —
-- bounding Apple-ID sharing / a leaked JWS. Already-bound devices always keep working.
CREATE TABLE IF NOT EXISTS transaction_devices (
  original_transaction_id TEXT NOT NULL,
  device_id               TEXT NOT NULL,               -- devices.device_id
  first_seen              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (original_transaction_id, device_id)
);
