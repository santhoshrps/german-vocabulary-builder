# Leaderboard capacity rig

Throwaway measurement harness for the app repo's
`docs/generic/leaderboard/design/capacity-model.md` §7. It fills the model's MEASURED
columns — the last hard gate before implementation approval. It is **not** the product
worker: no product behavior, a per-run token as its only auth, synthetic data only, and
everything (worker + database) is deleted when the run ends.

## One full run

```sh
export CLOUDFLARE_API_TOKEN='<leaderboard-dev-ops token from password manager>'
cd leaderboard-rig

# 1. Scratch resources (throwaway — never dev/prod)
npx wrangler d1 create german-social-scratch          # paste database_id into wrangler.toml
npx wrangler d1 execute german-social-scratch --remote --file=schema.sql
openssl rand -hex 24                                   # copy output…
npx wrangler secret put RIG_TOKEN                      # …paste when prompted
npx wrangler deploy                                    # note the printed workers.dev URL

# 2. Fixtures + fleet (capacity §7.1) — prints real blob bytes per shape and dbstat totals
node loadtest.mjs https://<worker-url> <rig-token> seed

# 3. Sustained writes (capacity §7.2) — the 116/s bar, then 2× headroom
node loadtest.mjs https://<worker-url> <rig-token> publish 116 1800
node loadtest.mjs https://<worker-url> <rig-token> publish 232 1800

# 4. Mixed reads under write load (capacity §7.4)
node loadtest.mjs https://<worker-url> <rig-token> mixed 116 116 600

# 5. Burst shed (capacity §7.3) — bounded 429s expected, zero data loss
node loadtest.mjs https://<worker-url> <rig-token> burst 1157 60

# 6. Query-plan evidence (capacity §7.5)
curl -H "x-rig-token: <rig-token>" "https://<worker-url>/plan?q=board"
curl -H "x-rig-token: <rig-token>" "https://<worker-url>/plan?q=publish"

# 7. TEAR DOWN — part of the run, not optional
npx wrangler delete
npx wrangler d1 delete german-social-scratch
```

## Recording results

Copy the printed numbers into `capacity-model.md`'s ☐ MEASURED columns (bytes per shape
and per table from `seed`/`/stats`; p50/p95 wall + server-side latencies per rate;
429 counts for the burst run), re-verify the platform-limit citations that day, and note
the run date in the model's basis row. If any number misses its bar (§7 targets), the
model's §6 decision — shard assignment caps, runway triggers — is recomputed from the
measured values before implementation approval is requested.

## Honest limitations

- Latency from a laptop includes the network; the server-side `ms` percentiles printed
  alongside are the authoritative transaction-time numbers.
- The harness runs commit A and commit B against ONE scratch database; the product splits
  them across the projection shard and `SOCIAL_DB`, so measured serial-write pressure here
  is *conservative* (worse than production topology).
- Free-plan accounts cannot run this (D1 size, Queues absent) — the account must be on
  Workers Paid, per the owner's 2026-07-25 decision.
