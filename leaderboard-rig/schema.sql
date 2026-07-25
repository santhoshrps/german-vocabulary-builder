-- Leaderboard capacity rig — SCRATCH schema (capacity-model.md §7).
-- Mirrors the physical shapes the contract declares for the tables that dominate
-- bytes and writes. This is measurement tooling, NOT the product schema; the
-- product's numbered migrations arrive with the worker after implementation
-- approval. Everything here is synthetic and the whole database is deleted
-- after the run.

-- Day-state (projection-shard shape): one row per (player, day), packed bucket blob.
CREATE TABLE IF NOT EXISTS day_state (
  player_id TEXT NOT NULL,
  day_u16 INTEGER NOT NULL,
  blob BLOB NOT NULL CHECK (length(blob) <= 1024),
  measure INTEGER NOT NULL,
  PRIMARY KEY (player_id, day_u16)
) WITHOUT ROWID;

-- SOCIAL_DB commit-B shape: registers + revision on the player row.
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL DEFAULT 'rig',
  board_revision INTEGER NOT NULL DEFAULT 0,
  registers BLOB NOT NULL DEFAULT x'',
  activity_bitmap BLOB NOT NULL DEFAULT x'',
  folded_through INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS checkpoints (
  player_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  earned_folded INTEGER NOT NULL DEFAULT 0,
  seconds_folded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, component_id)
) WITHOUT ROWID;

-- Friendship edges for the board-read fan-out (both-direction index per contract §5).
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (a, b),
  CHECK (a < b)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_friend_b ON friendships (b);
