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
