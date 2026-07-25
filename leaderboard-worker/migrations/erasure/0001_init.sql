-- ERASURE_DB 0001 — deletion journal, OUTSIDE SOCIAL_DB by design (IDENT-5b, §6.4):
-- restores of SOCIAL_DB replay live markers from here before serving traffic, and
-- this store is never restored to a point behind a restored SOCIAL_DB.

CREATE TABLE erasure_saga (
  player_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'journaled'
    CHECK (state IN ('journaled', 'erasing', 'external', 'done', 'failed')),
  capability_hash TEXT NOT NULL,     -- authenticates the status route after session death
  steps BLOB,                        -- per-step idempotent progress (S1–S6)
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL        -- ≥ longest recovery source, then aged out
) WITHOUT ROWID;
CREATE INDEX idx_saga_expiry ON erasure_saga (expires_at);

-- Live markers replayed on restore; result tombstones answer lost responses
-- without restoring social access.
CREATE TABLE erasure_markers (
  player_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_markers_expiry ON erasure_markers (expires_at);
