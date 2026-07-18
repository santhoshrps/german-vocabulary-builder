#!/bin/bash
# deploy.sh — the ONLY way workers reach any environment (MS2-FR-30b/30c).
#
#   scripts/deploy.sh <dev|test|prod>     deploy BOTH workers to one environment
#   scripts/deploy.sh all                 dev → test → prod, verifying each step
#
# Per environment, in order:
#   1. secret PARITY gate  — required secret NAMES must exist (wrangler secret list);
#                            a missing name aborts BEFORE deploy (the prod-missing-
#                            R2-secrets class of incident dies here, not as a 503).
#   2. deploy              — with DEPLOY_VERSION=<git sha> injected as a var.
#   3. wire-verify         — curl /health and assert status+env+version match what
#                            was just deployed. A verify that hits the wrong world
#                            or stale code FAILS the deploy.
# Production additionally requires typing 'prod' (skipped for dev/test).

set -euo pipefail
cd "$(dirname "$0")/.."

GIT_SHA=$(git rev-parse --short HEAD)
if [[ -n "$(git status --porcelain -- read-worker/src worker/src 2>/dev/null)" ]]; then
  echo "⚠️  worker sources have uncommitted changes — deploying tree state as ${GIT_SHA}-dirty" >&2
  GIT_SHA="${GIT_SHA}-dirty"
fi

# Required secret names per worker. CAs are prod-required (real attestations are
# verified only there); R2 presign pair is checked as a warning everywhere (its
# absence is a documented degraded mode, also visible on /health).
read_required=(SESSION_JWT_SECRET)
read_required_prod=(SESSION_JWT_SECRET APPLE_APPATTEST_ROOT_CA APPLE_STOREKIT_ROOT_CA)
read_warn=(R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)
write_required=(API_KEY)

env_flag() { # "" for prod (top-level config), "--env <name>" otherwise
  local env="$1"
  [[ "$env" == "prod" ]] && echo "" || echo "--env $env"
}

secret_names() { # dir, env — prints one secret name per line
  local dir="$1" env="$2"
  (cd "$dir" && npx wrangler secret list $(env_flag "$env") --format json 2>/dev/null) \
    | python3 -c 'import sys,json; [print(s["name"]) for s in json.load(sys.stdin)]'
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
  # takes a few seconds, so poll (up to ~30s) until the deployed version answers —
  # then assert strictly. A mismatch after the window is a real failure.
  local health ok=""
  for _ in 1 2 3 4 5 6; do
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
  deploy_and_verify read-worker "$env"
  deploy_and_verify worker "$env"
}

case "${1:-}" in
  dev|test|prod) do_env "$1" ;;
  all) do_env dev; do_env test; do_env prod ;;
  *) echo "usage: scripts/deploy.sh <dev|test|prod|all>" >&2; exit 1 ;;
esac
