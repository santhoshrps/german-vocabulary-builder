-- Immutable vocabulary change-feed history (contract version 1).
--
-- Apply to every CONTENT database after content_v2.sql. These tables are derived
-- publication metadata: the canonical word/translation tables remain the source
-- served by the legacy manifest and snapshot recovery paths.
--
-- The write Worker commits one routine publication with D1Database.batch():
-- word mutations, immutable history rows, and the meta pointer move are one
-- transaction. A failed batch therefore exposes neither a partial catalogue nor
-- an advanced cursor.

CREATE TABLE IF NOT EXISTS vocabulary_versions (
  sequence            INTEGER PRIMARY KEY,
  base_version        TEXT NOT NULL UNIQUE,
  dataset_generation  INTEGER NOT NULL,
  published_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vocabulary_version_views (
  sequence                    INTEGER NOT NULL,
  scope                       TEXT NOT NULL CHECK (scope IN ('free', 'full')),
  language                    TEXT NOT NULL,
  version                     TEXT NOT NULL,
  fingerprint                 TEXT NOT NULL,
  verbs_count                 INTEGER NOT NULL CHECK (verbs_count >= 0),
  nouns_count                 INTEGER NOT NULL CHECK (nouns_count >= 0),
  adverbs_adjectives_count    INTEGER NOT NULL CHECK (adverbs_adjectives_count >= 0),
  PRIMARY KEY (sequence, scope, language),
  UNIQUE (version, scope, language),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_views_lookup
  ON vocabulary_version_views (version, scope, language);

-- One final operation per canonical word id for each immutable publication/view.
-- `operation='changed'` carries the target composite content hash; a deletion has
-- no target hash. `previous_content_hash` describes immediate pre-operation
-- existence, allowing a multi-version reader to omit add→delete cycles that are
-- absent at both the client's starting cursor and the final target.
CREATE TABLE IF NOT EXISTS vocabulary_change_rows (
  sequence       INTEGER NOT NULL,
  scope          TEXT NOT NULL,
  language       TEXT NOT NULL,
  table_name     TEXT NOT NULL CHECK (
    table_name IN ('verbs', 'nouns', 'adverbs_adjectives')
  ),
  word_id        TEXT NOT NULL,
  operation      TEXT NOT NULL CHECK (operation IN ('changed', 'deleted')),
  content_hash   TEXT,
  previous_content_hash TEXT,
  PRIMARY KEY (sequence, scope, language, table_name, word_id),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence) ON DELETE CASCADE,
  CHECK (
    (operation = 'changed' AND content_hash IS NOT NULL)
    OR (operation = 'deleted' AND content_hash IS NULL
        AND previous_content_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_changes_chain
  ON vocabulary_change_rows (scope, language, sequence);

-- Full language-resolved wire rows only for changed ids. This is bounded by the
-- delta, not the catalogue. It lets /rows?...&version= serve the exact immutable
-- target even if a later publication lands while a client is downloading.
CREATE TABLE IF NOT EXISTS vocabulary_version_rows (
  sequence       INTEGER NOT NULL,
  scope          TEXT NOT NULL,
  language       TEXT NOT NULL,
  table_name     TEXT NOT NULL CHECK (
    table_name IN ('verbs', 'nouns', 'adverbs_adjectives')
  ),
  word_id        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  PRIMARY KEY (sequence, scope, language, table_name, word_id),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_rows_version_lookup
  ON vocabulary_version_rows (
    scope, language, table_name, word_id, sequence DESC
  );

CREATE TABLE IF NOT EXISTS vocabulary_alias_changes (
  sequence       INTEGER NOT NULL,
  scope          TEXT NOT NULL,
  language       TEXT NOT NULL,
  old_id         TEXT NOT NULL,
  new_id         TEXT NOT NULL,
  PRIMARY KEY (sequence, scope, language, old_id),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vocabulary_type_changes (
  sequence       INTEGER NOT NULL,
  scope          TEXT NOT NULL,
  language       TEXT NOT NULL,
  word_id        TEXT NOT NULL,
  from_table     TEXT NOT NULL,
  from_type      TEXT NOT NULL,
  to_table       TEXT NOT NULL,
  to_type        TEXT NOT NULL,
  PRIMARY KEY (sequence, scope, language, word_id),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_alias_chain
  ON vocabulary_alias_changes (scope, language, sequence);

CREATE INDEX IF NOT EXISTS idx_vocabulary_type_chain
  ON vocabulary_type_changes (scope, language, sequence);

-- Immutable, resumable full-install snapshots. Blocks are uploaded before a
-- manifest becomes visible; `committed=0` rows are unreachable from the read
-- worker. Publication atomically inserts the manifest, marks its exact blocks
-- committed and advances the per-scope/language pointer.
CREATE TABLE IF NOT EXISTS vocabulary_snapshot_manifests (
  snapshot_id                  TEXT PRIMARY KEY,
  sequence                     INTEGER NOT NULL,
  base_version                 TEXT NOT NULL,
  version                      TEXT NOT NULL,
  dataset_generation           INTEGER NOT NULL,
  schema_version               INTEGER NOT NULL,
  scope                        TEXT NOT NULL CHECK (scope IN ('free', 'full')),
  language                     TEXT NOT NULL,
  fingerprint                  TEXT NOT NULL,
  verbs_count                  INTEGER NOT NULL CHECK (verbs_count >= 0),
  nouns_count                  INTEGER NOT NULL CHECK (nouns_count >= 0),
  adverbs_adjectives_count     INTEGER NOT NULL CHECK (adverbs_adjectives_count >= 0),
  block_count                  INTEGER NOT NULL CHECK (block_count > 0),
  total_compressed_bytes       INTEGER NOT NULL CHECK (total_compressed_bytes >= 0),
  total_uncompressed_bytes     INTEGER NOT NULL CHECK (total_uncompressed_bytes >= 0),
  manifest_checksum            TEXT NOT NULL,
  published_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version, scope, language),
  FOREIGN KEY (sequence) REFERENCES vocabulary_versions(sequence)
);

CREATE TABLE IF NOT EXISTS vocabulary_snapshot_blocks (
  snapshot_id          TEXT NOT NULL,
  block_id             TEXT NOT NULL,
  table_name           TEXT NOT NULL CHECK (
    table_name IN ('verbs', 'nouns', 'adverbs_adjectives')
  ),
  block_index          INTEGER NOT NULL CHECK (block_index >= 0),
  row_count            INTEGER NOT NULL CHECK (row_count > 0),
  compressed_bytes     INTEGER NOT NULL CHECK (compressed_bytes > 0),
  uncompressed_bytes   INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  checksum             TEXT NOT NULL,
  payload              BLOB NOT NULL,
  committed            INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  uploaded_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_id, block_id),
  UNIQUE (snapshot_id, table_name, block_index)
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_snapshot_blocks_read
  ON vocabulary_snapshot_blocks (snapshot_id, committed, table_name, block_index);

CREATE TABLE IF NOT EXISTS vocabulary_snapshot_pointers (
  scope         TEXT NOT NULL CHECK (scope IN ('free', 'full')),
  language      TEXT NOT NULL,
  snapshot_id   TEXT NOT NULL,
  PRIMARY KEY (scope, language),
  FOREIGN KEY (snapshot_id) REFERENCES vocabulary_snapshot_manifests(snapshot_id)
);
