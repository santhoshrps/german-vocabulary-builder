-- PROJECTION_1 0001 — per-player day-state (capacity-model.md §6 store split).
-- Purely per-player rows; no cross-player transaction ever touches this store.
-- The 1 KiB blob CHECK is the enforced per-row cap (capacity §2).

CREATE TABLE day_state (
  player_id TEXT NOT NULL,
  day_u16 INTEGER NOT NULL,          -- days since epoch, u16
  blob BLOB NOT NULL CHECK (length(blob) <= 1024),
  measure INTEGER NOT NULL,          -- content-measure version (algebra v1.1 §2)
  PRIMARY KEY (player_id, day_u16)
) WITHOUT ROWID;
