-- PROJECTION 0002 — one row per (player, day, component) instead of a packed
-- per-day blob. Reason (W3): the F1/F7 join must be ATOMIC under concurrent
-- publishes from two devices of the same player; a per-component row makes the
-- join one guarded upsert (ON CONFLICT … WHERE excluded.measure > measure) with
-- no read-modify-write window. Typical users have one component, so row counts
-- match the capacity model; multi-device users pay one small row per device.
-- Dev holds no data yet — recreate outright.

DROP TABLE day_state;

CREATE TABLE day_state (
  player_id TEXT NOT NULL,
  day_u16 INTEGER NOT NULL,
  component_id TEXT NOT NULL,
  blob BLOB NOT NULL CHECK (length(blob) <= 1024),  -- counters + buckets, packed
  measure INTEGER NOT NULL,                          -- content-measure version
  content_hash TEXT NOT NULL,                        -- deterministic tie-break
  PRIMARY KEY (player_id, day_u16, component_id)
) WITHOUT ROWID;
