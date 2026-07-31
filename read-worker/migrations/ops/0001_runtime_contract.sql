-- Existing split OPS databases predate two runtime requirements:
--   1. StoreKit revocation lookup on every session mint.
--   2. Stable retry envelopes for scheduled broadcasts.
--
-- The migration intentionally creates `pending_sends` in its legacy shape before
-- adding `envelope`. That makes the same migration valid for both an existing
-- database (table present, column absent) and a brand-new empty database.

CREATE TABLE IF NOT EXISTS transaction_revocations (
  original_transaction_id TEXT PRIMARY KEY,
  reason                  TEXT NOT NULL,
  recorded_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_sends (
  id              TEXT PRIMARY KEY,
  descriptor      TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  audience        TEXT NOT NULL DEFAULT 'all',
  send_at         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE pending_sends ADD COLUMN envelope TEXT;
