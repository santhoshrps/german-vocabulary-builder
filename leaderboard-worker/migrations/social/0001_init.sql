-- SOCIAL_DB 0001 — relational + register store (server-contract.md §5).
-- Dev-only data until release; forward migrations refine before real users exist.

CREATE TABLE players (
  player_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24),
  session_version INTEGER NOT NULL DEFAULT 1,
  board_revision INTEGER NOT NULL DEFAULT 0,
  projection_shard INTEGER NOT NULL DEFAULT 1,
  tz_zone TEXT NOT NULL DEFAULT 'UTC',
  folded_through INTEGER NOT NULL DEFAULT 0,
  activity_bitmap BLOB NOT NULL DEFAULT x'',
  history_seed BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE credentials (
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  key_version INTEGER NOT NULL,
  hashed_subject TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players (player_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, key_version, hashed_subject)
) WITHOUT ROWID;
CREATE INDEX idx_credentials_player ON credentials (player_id);

CREATE TABLE refresh_sessions (
  family TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (player_id),
  hashed_token TEXT NOT NULL,
  prev_hashed_token TEXT,            -- rotation grace (IDENT-2c)
  rotated_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_refresh_player ON refresh_sessions (player_id);

CREATE TABLE registers (
  player_id TEXT PRIMARY KEY REFERENCES players (player_id),
  data BLOB NOT NULL,                -- F5/F6 encoding defined in W3 (algebra v1.1)
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE checkpoints (
  player_id TEXT NOT NULL REFERENCES players (player_id),
  component_id TEXT NOT NULL,
  earned_folded INTEGER NOT NULL DEFAULT 0,
  seconds_folded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, component_id)
) WITHOUT ROWID;

CREATE TABLE friendships (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
) WITHOUT ROWID;
CREATE INDEX idx_friendships_b ON friendships (b);

-- Per-pair monotonic generation + bounded tombstone (RELY-9); survives edge removal.
CREATE TABLE pair_state (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  tombstoned_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
) WITHOUT ROWID;

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  inviter TEXT NOT NULL REFERENCES players (player_id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'consumed', 'withdrawn', 'expired')),
  consumed_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- 30-day expiry (FRIEND-4)
) WITHOUT ROWID;
CREATE INDEX idx_invites_inviter ON invites (inviter);
CREATE INDEX idx_invites_expiry ON invites (expires_at);

CREATE TABLE blocks (
  owner TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, target)
) WITHOUT ROWID;

CREATE TABLE mutes (
  owner TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, target)
) WITHOUT ROWID;

-- Latest-only cheer per direction + quota marker (CHEER-2/3); no archive exists.
CREATE TABLE cheers (
  from_player TEXT NOT NULL,
  to_player TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_player, to_player)
) WITHOUT ROWID;
CREATE INDEX idx_cheers_to ON cheers (to_player);

-- E18: one pair guard ever; per-side receipts with server-finalized amount (FRIEND-11).
CREATE TABLE e18_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
) WITHOUT ROWID;

CREATE TABLE e18_receipts (
  receipt_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  pair_a TEXT NOT NULL,
  pair_b TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  tier_ordinal INTEGER NOT NULL,
  finalized_amount INTEGER,          -- NULL until first valid acknowledgement wins
  acked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_e18_player ON e18_receipts (player_id);

CREATE TABLE duo_receipts (
  player_id TEXT NOT NULL,
  award_id TEXT NOT NULL,
  day_label TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, award_id)
) WITHOUT ROWID;
CREATE INDEX idx_duo_day ON duo_receipts (player_id, day_label);

-- F3/F4 merged state (algebra v1.1 — commit B).
CREATE TABLE awards_window (
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  points INTEGER NOT NULL,
  day_label TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  everlasting INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, kind, dedup_key)
) WITHOUT ROWID;
CREATE INDEX idx_awards_day ON awards_window (player_id, day_label);

CREATE TABLE spends (
  player_id TEXT NOT NULL,
  repaired_day TEXT NOT NULL,
  amount INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  charge_bucket INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, repaired_day)
) WITHOUT ROWID;

-- Idempotency for social mutations ONLY — publish is exempt by documented
-- exception (ROBUST-6b; capacity §2).
CREATE TABLE idempotency (
  player_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result BLOB,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, route, idem_key)
) WITHOUT ROWID;
CREATE INDEX idx_idempotency_expiry ON idempotency (expires_at);

CREATE TABLE quotas (
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, kind, quota_day)
) WITHOUT ROWID;

-- Queue-less v1 outbox (NFR-1b): the cron executor drains this directly.
CREATE TABLE outbox (
  dedup_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('erasure', 'cleanup')),
  payload BLOB,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_outbox_due ON outbox (due_at);

CREATE TABLE moderation_reports (
  report_id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Sign-in nonces (W2) and runtime capability/config overrides.
CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
