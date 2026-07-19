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

## Custom domain switch-on (#33 — readiness checklist, not yet executed)

The workers serve from `*.workers.dev` today. Moving to a custom domain (e.g.
`api.<domain>` for prod, `api-dev.<domain>` / `api-test.<domain>`) is a config
flip, prepared so it can happen without a breaking moment:

1. **Zone**: add the domain to this Cloudflare account (nameservers moved).
   TLS certificates and HTTP/3 come with the zone automatically.
2. **Workers**: per environment in `read-worker/wrangler.toml` (and `worker/`),
   add `routes = [{ pattern = "api.<domain>", custom_domain = true }]` to the
   matching env block. Deploy via `scripts/deploy.sh` as always. The
   `workers.dev` URL KEEPS serving — both names are bound; nothing breaks.
3. **Verify**: `scripts/deploy.sh` wire-verifies against the URLs in its
   `read_url()` helper — update those to the new hostnames in the same commit
   that adds the routes (the typed prod gate applies as usual).
4. **App**: `BackendEnvironment.readWorkerURL` constants switch to the new
   hostnames in an ordinary release. Old installs keep working via workers.dev
   until they update (additive transition, no floor bump needed).
5. **Decommission**: after the fleet has moved (App Store analytics), set
   `workers_dev = false` per env to retire the old names.
6. **Not affected**: R2 presigned pack URLs (they point at the bucket host,
   not the worker), App Attest (bundle-id bound, not host bound), session JWTs
   (issuer is env-stamped, not host-stamped).

## Known limitations

- Loudness (EBU R128) measurement in `qa` requires ffmpeg (`brew install ffmpeg`);
  until installed, QA covers structure/duration/size only (deferred.md).
- The media pipeline's generation side (audio_sync/image_sync TTS + sourcing)
  still keys its caches by v1 ids — by design until the P2 media re-label is
  complete everywhere; `media_publish.py` maps to v2 at publish time.
