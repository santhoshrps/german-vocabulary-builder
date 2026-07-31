-- ERASURE_DB 0002 — preserve the encrypted provider-revocation credential in
-- the journal before SOCIAL_DB erasure. A crash after deleting credentials can
-- therefore still resume S5 instead of silently downgrading it to "skipped".

ALTER TABLE erasure_saga ADD COLUMN revocation BLOB;
ALTER TABLE erasure_saga ADD COLUMN outbox_checked_at INTEGER;

CREATE INDEX idx_saga_outbox_recovery
  ON erasure_saga (state, outbox_checked_at, requested_at);
