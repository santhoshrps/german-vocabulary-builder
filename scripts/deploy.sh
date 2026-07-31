#!/bin/bash
# deploy.sh — the ONLY way workers reach any environment (MS2-FR-30b/30c).
#
#   scripts/deploy.sh <dev|prod>          deploy all workers to one environment
#   scripts/deploy.sh all                 all workers: dev → prod
#   scripts/deploy.sh leaderboard-<dev|prod>
#                                         deploy only the leaderboard worker
#   scripts/deploy.sh leaderboard-all     leaderboard worker: dev → prod
#   (the standing test environment was retired 2026-07-25 — MS2-FR-32 revised)
#
# Per environment, in order:
#   1. secret PARITY gate  — required secret NAMES must exist (wrangler secret list);
#                            a missing name aborts BEFORE deploy (the prod-missing-
#                            R2-secrets class of incident dies here, not as a 503).
#   2. schema              — apply versioned OPS migrations, then idempotent OPS/content
#                            schemas before code can depend on them.
#   3. deploy              — with DEPLOY_VERSION=<git sha> injected as a var.
#   4. wire-verify         — curl /health and assert status+env+version + bounded
#                            runtime schema readiness match what was just deployed.
#                            A verify that hits the wrong world or stale code FAILS
#                            the deploy.
# Production additionally requires typing 'prod' (skipped for dev).

set -euo pipefail
cd "$(dirname "$0")/.."

GIT_SHA=$(git rev-parse --short HEAD)
if [[ "${1:-}" != "check-queue-config" ]] && \
   [[ -n "$(git status --porcelain -- read-worker worker leaderboard-worker schema scripts 2>/dev/null)" ]]; then
  echo "⚠️  worker sources have uncommitted changes — deploying tree state as ${GIT_SHA}-dirty" >&2
  GIT_SHA="${GIT_SHA}-dirty"
fi

# Required secret names per worker. CAs are prod-required (real attestations are
# verified only there); R2 presign pair is checked as a warning everywhere (its
# absence is a documented degraded mode, also visible on /health).
read_required=(SESSION_JWT_SECRET)
read_required_prod=(SESSION_JWT_SECRET APPLE_APPATTEST_ROOT_CA APPLE_STOREKIT_ROOT_CA)
read_warn=(R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY ADMIN_BROADCAST_TOKEN FCM_SERVICE_ACCOUNT)
write_required=(API_KEY)
lb_required=(SOCIAL_JWT_SECRET IDENTITY_HMAC_KEY_V1)

env_flag() { # "" for prod (top-level config), "--env <name>" otherwise
  local env="$1"
  [[ "$env" == "prod" ]] && echo "" || echo "--env $env"
}

secret_names() { # dir, env — prints one secret name per line
  local dir="$1" env="$2"
  (cd "$dir" && npx wrangler secret list $(env_flag "$env") --format json 2>/dev/null) \
    | python3 -c '
import sys, json
# wrangler intermittently prefixes banner/update noise (sometimes with ANSI
# escapes) — try every "[" until one parses as the JSON array.
raw = sys.stdin.read()
secrets = None
idx = raw.find("[")
while idx >= 0:
    try:
        secrets = json.loads(raw[idx:]); break
    except Exception:
        idx = raw.find("[", idx + 1)
[print(s["name"]) for s in (secrets or [])]'
}

WARN_NAMES=()  # optional-secret names for the next check_parity call (bash arrays
               # cannot ride an env-prefix assignment, so this is a plain global)
check_parity() { # dir, env, required...
  local dir="$1" env="$2"; shift 2
  local have; have=$(secret_names "$dir" "$env")
  local missing=()
  for name in "$@"; do
    grep -qx "$name" <<<"$have" || missing+=("$name")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "❌ $dir [$env]: missing required secret(s): ${missing[*]}" >&2
    echo "   set with: (cd $dir && npx wrangler secret put <NAME> $(env_flag "$env"))" >&2
    return 1
  fi
  for name in "${WARN_NAMES[@]:-}"; do
    if [[ -n "$name" ]] && ! grep -qx "$name" <<<"$have"; then
      echo "⚠️  $dir [$env]: optional secret $name not set (degraded mode; visible on /health)" >&2
    fi
  done
  return 0
}

verify_leaderboard_queue_config() { # env — static names/settings, no credentials
  local env="$1"
  python3 - "$env" <<'PY'
import pathlib, re, sys
env = sys.argv[1]
text = pathlib.Path("leaderboard-worker/wrangler.toml").read_text()
dev_marker = "[[env.dev.d1_databases]]"
selected = text[:text.index(dev_marker)] if env == "prod" else text[text.index(dev_marker):]
primary = f"german-social-outbox-{env}"
dlq = f"german-social-outbox-dlq-{env}"

prefix = "" if env == "prod" else r"env\.dev\."
def blocks(kind):
    pattern = rf"\[\[{prefix}queues\.{kind}\]\](.*?)(?=\n\[\[?|\Z)"
    return re.findall(pattern, selected, flags=re.S)
def string(block, key):
    match = re.search(rf"(?m)^{re.escape(key)}\s*=\s*\"([^\"]+)\"\s*$", block)
    return match.group(1) if match else None
def integer(block, key):
    match = re.search(rf"(?m)^{re.escape(key)}\s*=\s*(\d+)\s*$", block)
    return int(match.group(1)) if match else None

producers = [p for p in blocks("producers") if string(p, "binding") == "SOCIAL_OUTBOX"]
consumers = [c for c in blocks("consumers") if string(c, "queue") == primary]
problems = []
if len(producers) != 1 or string(producers[0], "queue") != primary:
    problems.append(f"SOCIAL_OUTBOX producer != {primary}")
if len(consumers) != 1:
    problems.append(f"consumer != {primary}")
else:
    expected = {
        "dead_letter_queue": dlq,
        "max_batch_size": 5,
        "max_batch_timeout": 2,
        "max_retries": 5,
        "retry_delay": 60,
        "max_concurrency": 2,
    }
    for key, value in expected.items():
        actual = string(consumers[0], key) if isinstance(value, str) else integer(consumers[0], key)
        if actual != value:
            problems.append(f"{key}={actual!r}, expected {value!r}")
queue_var = re.search(r'(?m)^SOCIAL_OUTBOX_QUEUE\s*=\s*"([^"]+)"\s*$', selected)
if not queue_var or queue_var.group(1) != primary:
    problems.append("SOCIAL_OUTBOX_QUEUE var mismatch")
if problems:
    print(f"❌ leaderboard-worker [{env}] Queue config: " + "; ".join(problems))
    raise SystemExit(1)
print(f"✅ leaderboard-worker [{env}] Queue config: {primary} → {dlq}")
PY
}

check_queue_resources() { # env — presence only; never reads message bodies
  local env="$1"
  local primary="german-social-outbox-$env"
  local dlq="german-social-outbox-dlq-$env"
  local listed
  listed=$(cd leaderboard-worker && \
    WRANGLER_LOG_PATH="/tmp/leaderboard-queues-$env.log" \
    npx --prefix ../read-worker wrangler queues list 2>&1) \
    || { echo "$listed" >&2; return 1; }
  local missing=()
  grep -Fq "$primary" <<<"$listed" || missing+=("$primary")
  grep -Fq "$dlq" <<<"$listed" || missing+=("$dlq")
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "❌ leaderboard-worker [$env]: missing Queue resource(s): ${missing[*]}" >&2
    echo "   create explicitly with: scripts/provision-leaderboard-queues.sh $env" >&2
    return 1
  fi
  echo "✅ leaderboard-worker [$env]: Queue resources present: $primary, $dlq"
}

deploy_and_verify() { # dir, env
  local dir="$1" env="$2"
  echo "── deploying $dir → $env (version $GIT_SHA)"
  local out
  out=$(cd "$dir" && npx wrangler deploy $(env_flag "$env") --var "DEPLOY_VERSION:$GIT_SHA" 2>&1) \
    || { echo "$out" >&2; return 1; }
  local url
  url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1)
  if [[ -z "$url" ]]; then
    echo "❌ could not find deployed URL in wrangler output" >&2; echo "$out" >&2; return 1
  fi
  # Wire-verify: status + env + version must all match THIS deploy. Edge propagation
  # can take more than 30 seconds, so poll (up to ~90s) until the deployed version answers —
  # then assert strictly. A mismatch after the window is a real failure.
  local health ok=""
  for _ in {1..18}; do
    health=$(curl -fsS --max-time 15 "$url/health" || true)
    if echo "$health" | python3 -c "
import sys, json
try: h = json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if h.get('version') == '$GIT_SHA' else 1)
"; then ok=1; break; fi
    sleep 5
  done
  [[ -n "$ok" ]] || { echo "❌ $url/health never served version $GIT_SHA (last: $health)" >&2; return 1; }
  echo "$health" | python3 -c "
import sys, json
h = json.load(sys.stdin)
env, sha = '$env', '$GIT_SHA'
problems = []
if h.get('status') != 'ok': problems.append(f\"status={h.get('status')} missing={h.get('missing')}\")
if h.get('env') != env: problems.append(f\"env={h.get('env')!r}, expected {env!r}\")
if problems:
    print('❌ wire-verify FAILED: ' + '; '.join(problems)); sys.exit(1)
deg = h.get('degraded') or []
extra = f' (degraded: {deg})' if deg else ''
print(f'✅ {env} verified at ' + '$url' + f' — version {sha}{extra}')
"
}

apply_content_schema() { # env
  local env="$1"
  local database
  if [[ "$env" == "prod" ]]; then
    database="german-content-prod"
  else
    database="german-content-dev"
  fi
  echo "── applying idempotent vocabulary change-feed schema → $env"
  (cd worker && npx wrangler d1 execute "$database" --remote \
    --yes --file=../schema/content_change_feed.sql $(env_flag "$env"))
}

apply_operational_schema() { # env
  local env="$1"
  local database
  if [[ "$env" == "prod" ]]; then
    database="german-ops-prod"
  else
    database="german-ops-dev"
  fi
  echo "── applying versioned operational migrations → $env"
  # Wrangler skips confirmation in CI mode but still captures its automatic D1
  # backup. Each migration is transactional and recorded in d1_migrations.
  (cd read-worker && CI=true npx wrangler d1 migrations apply "$database" \
    --remote $(env_flag "$env"))
  echo "── reconciling canonical operational schema → $env"
  (cd read-worker && npx wrangler d1 execute "$database" --remote --yes \
    --file=../schema/ops.sql $(env_flag "$env"))
}

apply_leaderboard_schema() { # env — migrations MUST precede Queue-aware code
  local env="$1"
  echo "── applying leaderboard D1 migrations → $env"
  for binding in SOCIAL_DB ERASURE_DB PROJECTION_1; do
    (cd leaderboard-worker && CI=true \
      npx --prefix ../read-worker wrangler d1 migrations apply "$binding" \
      --remote $(env_flag "$env"))
  done
}

do_env() {
  local env="$1"
  if [[ "$env" == "prod" ]]; then
    if [[ -f PROD_FREEZE ]]; then
      echo "❌ production deploys are frozen (see PROD_FREEZE). The cutover step lifts this." >&2
      exit 1
    fi
    read -r -p "About to deploy PRODUCTION. Type 'prod' to continue: " answer
    [[ "$answer" == "prod" ]] || { echo "aborted" >&2; exit 1; }
    WARN_NAMES=("${read_warn[@]}"); check_parity read-worker "$env" "${read_required_prod[@]}"
  else
    WARN_NAMES=("${read_warn[@]}"); check_parity read-worker "$env" "${read_required[@]}"
  fi
  WARN_NAMES=(); check_parity worker "$env" "${write_required[@]}"
  WARN_NAMES=(); check_parity leaderboard-worker "$env" "${lb_required[@]}"
  verify_leaderboard_queue_config "$env"
  (cd leaderboard-worker && npm run bindings:check)
  check_queue_resources "$env"
  # Operational migrations land before the read worker can expose/use their
  # contract. The canonical schemas then make a fresh database complete while
  # remaining no-ops for existing objects.
  apply_operational_schema "$env"
  apply_content_schema "$env"
  apply_leaderboard_schema "$env"
  deploy_and_verify read-worker "$env"
  deploy_and_verify worker "$env"
  deploy_and_verify leaderboard-worker "$env"
}

do_leaderboard_env() {
  local env="$1"
  if [[ "$env" == "prod" ]]; then
    if [[ -f PROD_FREEZE ]]; then
      echo "❌ production deploys are frozen (see PROD_FREEZE). The cutover step lifts this." >&2
      exit 1
    fi
    read -r -p "About to deploy leaderboard PRODUCTION. Type 'prod' to continue: " answer
    [[ "$answer" == "prod" ]] || { echo "aborted" >&2; exit 1; }
  fi
  WARN_NAMES=(); check_parity leaderboard-worker "$env" "${lb_required[@]}"
  verify_leaderboard_queue_config "$env"
  (cd leaderboard-worker && npm run bindings:check)
  check_queue_resources "$env"
  apply_leaderboard_schema "$env"
  deploy_and_verify leaderboard-worker "$env"
}

case "${1:-}" in
  dev|prod) do_env "$1" ;;
  all) do_env dev; do_env prod ;;
  leaderboard-dev) do_leaderboard_env dev ;;
  leaderboard-prod) do_leaderboard_env prod ;;
  leaderboard-all) do_leaderboard_env dev; do_leaderboard_env prod ;;
  check-queue-config)
    [[ "${2:-}" == "dev" || "${2:-}" == "prod" ]] \
      || { echo "usage: scripts/deploy.sh check-queue-config <dev|prod>" >&2; exit 1; }
    verify_leaderboard_queue_config "$2"
    ;;
  *)
    echo "usage: scripts/deploy.sh <dev|prod|all|leaderboard-dev|leaderboard-prod|leaderboard-all|check-queue-config ENV>" >&2
    exit 1
    ;;
esac
