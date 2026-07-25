-- SOCIAL_DB 0002 — columns the W3 merge needs for deterministic SQL-level joins.

-- F3 tie-break winner is min(bucket, componentID) (algebra §3.3).
ALTER TABLE awards_window ADD COLUMN source_component TEXT NOT NULL DEFAULT '';
-- F4 charge winner is min(chargeBucket, componentID); refunded ORs (algebra §3.4).
ALTER TABLE spends ADD COLUMN source_component TEXT NOT NULL DEFAULT '';
-- Optimistic-concurrency version for the registers read-merge-write (retried,
-- bounded): joins are idempotent, but a lost concurrent write would DROP a merge,
-- not just reorder it — the version guard makes the race a retry, never a loss.
ALTER TABLE registers ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
