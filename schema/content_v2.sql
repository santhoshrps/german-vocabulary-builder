-- CONTENT schema v2 (WD-ID, LG-FR-9): level-free word identity + translations as
-- rows. Applied per environment as its world cuts over to v2 (test at P1, dev and
-- prod at the P2 cutover). Idempotent for a fresh database; for a database still
-- carrying v1 tables, drop them first (content is reproducible by construction).
--
--   npx wrangler d1 execute german-content-test --remote --file=schema/content_v2.sql
--
-- Every table follows the {id, content_hash} convention so the pipeline's
-- state/diff protocol (sync.py <-> write worker) applies unchanged to all of them.

-- German core: identity id = sha256(type|word|article|sense)[:16] (sync/registry.py).
-- No translation columns here — source-language text lives in `translations`.

CREATE TABLE IF NOT EXISTS verbs (
  id              TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  free            INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  word            TEXT NOT NULL,
  sense           TEXT,                            -- homonym tag (WD-ID-3); NULL = only sense
  german_sentence  TEXT,
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
  free            INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  article         TEXT,                            -- der/die/das or slash combination
  word            TEXT NOT NULL,
  plural          TEXT,
  sense           TEXT,
  image           INTEGER NOT NULL DEFAULT 0,
  german_sentence  TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adverbs_adjectives (
  id              TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  free            INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL,
  capital         TEXT,
  type            TEXT NOT NULL,
  word            TEXT NOT NULL,
  sense           TEXT,
  german_sentence  TEXT,
  comparative     TEXT,
  superlative     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Source-language text: one row per word × language (LG-FR-9). id = "<word_id>:<lang>"
-- keeps the {id, content_hash} sync protocol; (word_id, lang) is the semantic key.
-- Variants are stored sparse exactly as authored; the read worker overlays a variant
-- on its base at serve time (LG-FR-12).
CREATE TABLE IF NOT EXISTS translations (
  id              TEXT PRIMARY KEY,                -- "<word_id>:<lang>"
  content_hash    TEXT NOT NULL,
  word_id         TEXT NOT NULL,
  lang            TEXT NOT NULL,                   -- registry code: en, en-US, es-MX, zh, ...
  word            TEXT NOT NULL,
  sentence        TEXT,
  article         TEXT,                            -- languages with gendered articles (es)
  article_plural  TEXT,                            -- plural article (es: los/las)
  plural          TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (word_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_translations_lang ON translations (lang);
CREATE INDEX IF NOT EXISTS idx_translations_word ON translations (word_id);

-- Identity re-key map (WD-ID-4/5): v1 id (level|word) -> v2 id. Serves the app's
-- one-time migration and the media re-label; rename aliases join the same table
-- with their own reason.
CREATE TABLE IF NOT EXISTS id_aliases (
  id              TEXT PRIMARY KEY,                -- the OLD id
  content_hash    TEXT NOT NULL,
  new_id          TEXT NOT NULL,
  reason          TEXT NOT NULL,                   -- 'v2-rekey' | 'rename'
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_id_aliases_new ON id_aliases (new_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
