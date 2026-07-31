-- SOCIAL_DB 0004 — Queue dispatch/consumer state.
--
-- Supersedes the historical queue-less executor in 0001. Queue acceptance is a
-- lease only; rows remain authoritative until terminal consumer completion.

ALTER TABLE outbox ADD COLUMN dispatched_at INTEGER;
ALTER TABLE outbox ADD COLUMN dispatch_lease_until INTEGER;
ALTER TABLE outbox ADD COLUMN processing_lease_until INTEGER;
ALTER TABLE outbox ADD COLUMN dispatch_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE outbox ADD COLUMN last_error_code TEXT;
ALTER TABLE outbox ADD COLUMN completed_at INTEGER;

CREATE INDEX idx_outbox_dispatchable
  ON outbox (completed_at, due_at, dispatch_lease_until);
CREATE INDEX idx_outbox_completed ON outbox (completed_at);
