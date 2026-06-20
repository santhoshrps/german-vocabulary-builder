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

-- Example: the app's built-in free-tier code (200-word preview):
--   printf 'flashcard-free-2026' | shasum -a 256
--   INSERT INTO promo_codes (code_hash, label, tier) VALUES ('<hash>', 'builtin-free', 'free');
-- A full-access code (alternative to a StoreKit purchase):
--   printf 'SOME-FULL-CODE' | shasum -a 256
--   INSERT INTO promo_codes (code_hash, label, tier) VALUES ('<hash>', 'full-grant', 'full');
