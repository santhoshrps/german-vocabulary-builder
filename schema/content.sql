-- CONTENT database schema (MS2-FR-29): the published vocabulary. One database per
-- environment (german-content-{prod,dev,test}). Reproducible at any time from the
-- pipeline sources (xlsx + sync) — this database is REWRITTEN by publishes and holds
-- nothing precious. Written only by the write worker; the read worker's access is
-- SELECT-only by construction (read-worker/src/db.ts).
--
--   npx wrangler d1 execute german-content-dev --remote --file=schema/content.sql
--
-- (Legacy single-database world: schema/init.sql + the content half of
--  read-worker/schema/extra.sql. Kept until the old database is decommissioned.)

CREATE TABLE IF NOT EXISTS verbs (
  id              TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  free            INTEGER NOT NULL DEFAULT 0,   -- 1 = part of the free 200-word preview tier
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  word            TEXT NOT NULL,
  english         TEXT NOT NULL,
  german_sentence  TEXT,
  english_sentence TEXT,
  ich             TEXT,
  du              TEXT,
  er_sie_es       TEXT,
  wir             TEXT,
  ihr             TEXT,
  sie_sie         TEXT,
  past_participle  TEXT,
  simple_past      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nouns (
  id              TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  free            INTEGER NOT NULL DEFAULT 0,   -- 1 = part of the free 200-word preview tier
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  article         TEXT,
  word            TEXT NOT NULL,
  plural          TEXT,
  image           INTEGER NOT NULL DEFAULT 0,
  english         TEXT NOT NULL,
  german_sentence  TEXT,
  english_sentence TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adverbs_adjectives (
  id              TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  free            INTEGER NOT NULL DEFAULT 0,   -- 1 = part of the free 200-word preview tier
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  word            TEXT NOT NULL,
  english         TEXT NOT NULL,
  german_sentence  TEXT,
  english_sentence TEXT,
  comparative     TEXT,
  superlative     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optional explicit dataset version, bumped by the publish pipeline via the write
-- worker. If absent, the read worker derives a version from per-table COUNT(*) +
-- MAX(updated_at) (which also reflects deletions).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
