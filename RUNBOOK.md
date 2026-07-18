# Operations Runbook

How to run, verify, and — if it ever comes to it — rebuild every backend piece
from nothing (MS2-FR-21). Environments are `dev` / `test` / `prod`; every command
is environment-explicit; prod actions require typing `prod`.

## Where truth lives

| Thing | Source of truth | Reproducible? |
|---|---|---|
| Vocabulary | `data/*.xlsx` (this machine + its backups) | — the origin |
| Word DBs (`german-content-*`) | rebuilt from xlsx via `sync.py` | fully |
| Media masters | `sync/audio_cache/`, `sync/image_cache/` + `image_decisions.json`; mirrored to each bucket (`audio/files/`, `image/files/`) | fully (re-synthesis costs Azure money) |
| Packs/catalogs/manifests | rebuilt from masters via `media_publish.py` | fully |
| OPS DB (`german-ops-prod`) | **IRREPLACEABLE** — devices, codes, claims, submissions, purchases | backup only |
| Secrets | Cloudflare (workers) + `sync/.env*` (pipeline) | re-issue on loss |

## Daily commands

```
# words                                    # media
sync/.venv/bin/python sync/sync.py --env dev          sync/.venv/bin/python sync/media_publish.py publish --env dev
sync/.venv/bin/python sync/sync.py --env prod         sync/.venv/bin/python sync/media_publish.py publish --env prod   # -> beta
                                                      sync/.venv/bin/python sync/media_publish.py promote --env prod  # beta -> live
                                                      sync/.venv/bin/python sync/media_publish.py rollback --env prod

# workers                                  # verification
scripts/deploy.sh dev|test|prod            sync/.venv/bin/python sync/media_publish.py audit --env X [--deep]
                                           sync/.venv/bin/python sync/media_publish.py qa --env X
                                           sync/.venv/bin/python sync/media_publish.py status --env X

# safety                                   # hygiene
scripts/backup-ops.sh backup               sync/.venv/bin/python sync/media_publish.py gc --env X [--apply]
scripts/backup-ops.sh restore-drill        sync/.venv/bin/python sync/media_publish.py mirror-masters --env X
scripts/backup-ops.sh install-schedule     read-worker/scripts/promo.sh --env X list
```

## Full rebuild from nothing (disaster runbook)

1. `wrangler d1 create` the six DBs + `wrangler r2 bucket create` the three buckets
   (names in `read-worker/wrangler.toml`); update the ids there and in
   `worker/wrangler.toml`.
2. Apply schemas: `schema/content_v2.sql` per content DB, `schema/ops.sql` per ops DB.
3. Restore prod-ops from the latest `backups/ops-prod-*.sql`
   (`wrangler d1 execute german-ops-prod --remote --file=...`).
4. Set secrets per environment (names listed in `read-worker/wrangler.toml`;
   generate fresh values) and recreate `sync/.env.<env>` overlays.
5. `scripts/deploy.sh all`.
6. Words: `sync.py --env dev` → verify → `--env prod`.
7. Media: `media_publish.py publish --env dev`, `mirror-masters`, then prod via
   beta → `promote`. Missing local masters hydrate from any surviving bucket's
   `audio/files/` / `image/files/` before resorting to re-synthesis.
8. `audit --deep` every environment; `scripts/backup-ops.sh restore-drill`.

## Rollout visibility (#31)

- Every publish ends with one `MEDIATRACE publish` JSON line (env, channel,
  version, packs, bytes, entries) — grep your terminal scrollback or CI log.
- The workers emit `MEDIATRACE` events (pack serves, cache misses, packurl
  mints): `cd read-worker && npx wrangler tail [--env dev] --format json | grep MEDIATRACE`.
- `/health` on every worker: env identity, deployed git SHA, missing/degraded
  config names. The deploy script asserts it after every deploy.

## Known limitations

- Loudness (EBU R128) measurement in `qa` requires ffmpeg (`brew install ffmpeg`);
  until installed, QA covers structure/duration/size only (deferred.md).
- The media pipeline's generation side (audio_sync/image_sync TTS + sourcing)
  still keys its caches by v1 ids — by design until the P2 media re-label is
  complete everywhere; `media_publish.py` maps to v2 at publish time.
