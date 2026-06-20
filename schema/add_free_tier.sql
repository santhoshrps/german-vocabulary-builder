-- Migration: add the free-tier (200-word preview) flag to vocabulary tables and
-- the access tier to promo codes. Run ONCE against the existing D1 database:
--
--   wrangler d1 execute german-vocabulary --remote --file=schema/add_free_tier.sql
--
-- New fresh setups get these columns from schema/init.sql + read-worker/schema/extra.sql
-- directly, but ALTER is needed for an already-populated database.

ALTER TABLE verbs              ADD COLUMN free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nouns              ADD COLUMN free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adverbs_adjectives ADD COLUMN free INTEGER NOT NULL DEFAULT 0;

ALTER TABLE promo_codes        ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

-- After this, mark your curated preview rows, e.g.:
--   UPDATE nouns SET free = 1 WHERE level = 'A1' AND word IN ('Hund', 'Katze', ...);
-- and (re)insert promo codes with an explicit tier (see read-worker/schema/extra.sql).
