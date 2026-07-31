#!/bin/bash
# Explicit, idempotent Queue/DLQ provisioning for one standing environment.
# This script creates resources only; deployment and consumer attachment remain
# owned by scripts/deploy.sh after migrations and parity checks.

set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
if [[ "$env" != "dev" && "$env" != "prod" ]]; then
  echo "usage: scripts/provision-leaderboard-queues.sh <dev|prod>" >&2
  exit 1
fi

if [[ "$env" == "prod" ]]; then
  read -r -p "Create/verify PRODUCTION leaderboard Queues. Type 'prod' to continue: " answer
  [[ "$answer" == "prod" ]] || { echo "aborted" >&2; exit 1; }
fi

primary="german-social-outbox-$env"
dlq="german-social-outbox-dlq-$env"
listed=$(cd leaderboard-worker && \
  WRANGLER_LOG_PATH="/tmp/leaderboard-queues-$env.log" \
  npx --prefix ../read-worker wrangler queues list 2>&1)

for queue in "$primary" "$dlq"; do
  if grep -Fq "$queue" <<<"$listed"; then
    echo "✓ Queue already exists: $queue"
    (cd leaderboard-worker && \
      WRANGLER_LOG_PATH="/tmp/leaderboard-queues-$env.log" \
      npx --prefix ../read-worker wrangler queues update "$queue" \
        --delivery-delay-secs 0 --message-retention-period-secs 86400)
  else
    echo "── creating Queue: $queue"
    (cd leaderboard-worker && \
      WRANGLER_LOG_PATH="/tmp/leaderboard-queues-$env.log" \
      npx --prefix ../read-worker wrangler queues create "$queue" \
        --delivery-delay-secs 0 --message-retention-period-secs 86400)
  fi
done

echo "✅ Queue resources ready for $env: $primary, $dlq"
