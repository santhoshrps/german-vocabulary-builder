-- OPS database schema (MS2-FR-29): operational state — devices, entitlement claims,
-- submissions, feedback, usage counters, auth nonces and rate limits. One database per
-- environment (german-ops-{prod,dev,test}). The PROD ops database is IRREPLACEABLE
-- (unlike content it cannot be regenerated) — it is exported on a schedule by
-- scripts/backup-ops.sh (MS2-FR-30d) and is never touched by content publishes.
--
--   npx wrangler d1 execute german-ops-dev --remote --file=schema/ops.sql
--
-- (Legacy single-database world: the ops half of read-worker/schema/extra.sql.
--  Kept until the old database is decommissioned.)

-- App Attest device registry: one row per attested device key.
CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,                       -- App Attest keyId (base64url of SHA256(pubkey))
  public_key TEXT NOT NULL,                          -- base64 SPKI DER of the attested P-256 key
  sign_count INTEGER NOT NULL DEFAULT 0,             -- last seen assertion counter (anti-replay/clone)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

-- Promo codes. Store only the SHA-256 (hex) of each code, never the code itself.
-- `tier`: 'free' -> curated preview rows only; 'full' -> entire dataset.
CREATE TABLE IF NOT EXISTS promo_codes (
  code_hash  TEXT PRIMARY KEY,                       -- sha256(code) hex
  label      TEXT,
  tier       TEXT NOT NULL DEFAULT 'free',           -- 'free' | 'full'
  active     INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT                                    -- ISO8601 or NULL for no expiry
);

-- User-submitted words awaiting curation (POST /v1/submissions). Never published
-- automatically; a curator reviews and republishes through the pipeline.
CREATE TABLE IF NOT EXISTS submissions (
  id         TEXT PRIMARY KEY,                       -- random uuid
  word       TEXT NOT NULL,                          -- the German word the user typed
  client_key TEXT,                                   -- app's stable word id (custom-<uuid>) for upserts; NULL for search-submits
  type       TEXT,                                   -- optional: 'noun' | 'verb' | 'adjective' | 'adverb'
  details    TEXT,                                   -- optional JSON: full fields of a shared custom word
  source     TEXT,                                   -- session subject (e.g. 'promo:label' or device id)
  scope      TEXT,                                   -- caller scope at submit time ('free' | 'full')
  status     TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'approved' | 'rejected'
  lang       TEXT NOT NULL DEFAULT 'en',              -- submitter's source language (LG-FR-14)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);
-- Stable per-word key from the app (`custom-<uuid>`): repeated shares of one word UPSERT
-- the same curation row (app spec CW-FR-ADD-6), so the curator sees one current version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_client_key
  ON submissions (client_key) WHERE client_key IS NOT NULL;

-- "Not enjoying" review feedback (reviews.md RV-FR-FDBK). D1 only; reviewed manually.
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,                       -- random uuid
  subject     TEXT NOT NULL,                          -- session subject (rate-limit key)
  text        TEXT NOT NULL,                          -- sanitized free text, <= 500 chars
  app_version TEXT NOT NULL,                          -- e.g. '1.2'
  cefr_level  TEXT NOT NULL,                          -- e.g. 'A1.1'
  locale      TEXT NOT NULL,                          -- e.g. 'en_DE'
  status      TEXT NOT NULL DEFAULT 'new',            -- 'new' | 'read'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')) -- UTC
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at);

-- Content reports (words.md WD-REP-5): a learner flagged a clip/picture/card at the
-- moment they met it. Stored pending for MANUAL curator review — never auto-acted-on;
-- the fix flows through the normal content pipeline and the curator closes the row.
CREATE TABLE IF NOT EXISTS content_reports (
  id          TEXT PRIMARY KEY,                       -- random uuid
  word_id     TEXT NOT NULL,                          -- the word's stable id (v2, 16 hex)
  kind        TEXT NOT NULL,                          -- 'word' | 'plural' | 'sentence' | 'image' | 'card'
  reason      TEXT,                                   -- fixed reason slug (media reports); NULL for card
  comment     TEXT,                                   -- optional sanitized free text, <= 500 chars
  fingerprint TEXT,                                   -- content hash of the reported file (stale-report detection)
  subject     TEXT NOT NULL,                          -- session subject (rate-limit key only, no PII)
  app_version TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'reviewed'
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports (status, created_at);

-- Per-device lifetime count of free-tier search requests (cap enforced in prod only).
CREATE TABLE IF NOT EXISTS search_usage (
  device_id     TEXT PRIMARY KEY,                     -- devices.device_id
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time App Attest challenges (nonces): consumed by a single conditional DELETE
-- (atomic in SQLite), GC'd opportunistically on issue.
CREATE TABLE IF NOT EXISTS challenges (
  challenge  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL                        -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges (expires_at);

-- Fixed-window rate-limit counters (atomic upsert-RETURNING; hard bound under concurrency).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,                       -- "<name>:<subject>:<window-number>"
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL                        -- unix seconds (window end + grace)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits (expires_at);

-- Devices bound to a StoreKit purchase (per originalTransactionId; TRANSACTION_DEVICE_CAP).
CREATE TABLE IF NOT EXISTS transaction_devices (
  original_transaction_id TEXT NOT NULL,
  device_id               TEXT NOT NULL,               -- devices.device_id
  first_seen              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (original_transaction_id, device_id)
);

-- Devices bound to a FULL-tier promo code (UA-FR-4b personal codes; PROMO_DEVICE_CAP).
CREATE TABLE IF NOT EXISTS promo_claims (
  code_hash  TEXT NOT NULL,                            -- promo_codes.code_hash
  device_id  TEXT NOT NULL,                            -- devices.device_id
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code_hash, device_id)
);
