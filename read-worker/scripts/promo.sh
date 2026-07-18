#!/bin/bash
# promo.sh — admin tool for PERSONAL full-access codes (app spec UA-FR-4b).
#
# One code per person. A full-tier code binds to the first PROMO_DEVICE_CAP (3) attested
# devices that redeem it (promo_claims, enforced in src/entitlement.ts claimPromoDevice);
# anyone else gets "code already in use". Revocation is per code, i.e. per person, and
# takes effect within the session TTL (1 h).
#
# Usage (from anywhere; talks to the REMOTE OPS database of ONE environment —
# MS2-FR-29. --env is REQUIRED: an admin tool always names its world explicitly):
#   scripts/promo.sh --env <dev|test|prod> create <label> [expires-ISO8601]  mint a code, print it ONCE
#   scripts/promo.sh --env <dev|test|prod> list          all codes + tier/active/expiry/claimed devices
#   scripts/promo.sh --env <dev|test|prod> revoke <label>   disable — the person loses access
#   scripts/promo.sh --env <dev|test|prod> enable <label>   re-enable a revoked code
#   scripts/promo.sh --env <dev|test|prod> unclaim <label>  free ALL device slots (code stays valid)
#   scripts/promo.sh --env <dev|test|prod> delete <label>   remove the code and its claims entirely
#
# The plaintext code is printed exactly once at create time and stored ONLY as a SHA-256
# hash — it cannot be recovered later. Codes use A-Z/2-9 without I/O/0/1 (unambiguous to
# read aloud) and match the app's input rules (letters/digits/dash, <= 64 chars).

set -euo pipefail
cd "$(dirname "$0")/.."   # read-worker/, where wrangler.toml lives

# Environment selection (MS2-FR-29): promo codes live in the per-environment OPS
# database. No default on purpose — a personal code minted into the wrong world is
# an entitlement bug, so the operator always states the target.
if [[ "${1:-}" == "--env" ]]; then
  ENV_NAME="${2:-}"; shift 2 || true
else
  echo "error: --env <dev|test|prod> is required (first argument)" >&2; exit 1
fi
case "$ENV_NAME" in
  dev|test|prod) DB="german-ops-$ENV_NAME" ;;
  *) echo "error: unknown environment '$ENV_NAME' (dev|test|prod)" >&2; exit 1 ;;
esac
echo "→ environment: $ENV_NAME (database: $DB)" >&2

run() { npx wrangler d1 execute "$DB" --remote --command "$1"; }

require_label() {
  local label="${1:-}"
  if [[ -z "$label" ]]; then echo "error: missing <label>" >&2; exit 1; fi
  if [[ ! "$label" =~ ^[A-Za-z0-9_-]{1,40}$ ]]; then
    echo "error: label must be 1-40 chars of A-Z a-z 0-9 - _" >&2; exit 1
  fi
}

hash_of_label_sql() { echo "(SELECT code_hash FROM promo_codes WHERE label = '$1')"; }

cmd="${1:-help}"
case "$cmd" in
  create)
    require_label "${2:-}"
    label="$2"
    expires="${3:-}"
    if [[ -n "$expires" && ! "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]; then
      echo "error: expiry must be ISO-8601 UTC, e.g. 2027-01-31T00:00:00Z" >&2; exit 1
    fi
    # Refuse duplicate labels: revoke/unclaim address codes BY label, so a label must
    # identify exactly one code (the table only enforces uniqueness of the hash).
    existing=$(npx wrangler d1 execute "$DB" --remote --json \
      --command "SELECT COUNT(*) AS n FROM promo_codes WHERE label = '$label'" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["results"][0]["n"])')
    if [[ "$existing" != "0" ]]; then
      echo "error: a code labeled '$label' already exists (labels must be unique)" >&2; exit 1
    fi
    # 12 random chars from an unambiguous alphabet (no I/O/0/1), grouped for readability.
    # Bounded head FIRST (a raw /dev/urandom pipe dies of SIGPIPE under pipefail), then
    # filter; 4096 source bytes make a short result practically impossible — but verify.
    raw=$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-HJ-NP-Z2-9' | cut -c 1-12)
    if [[ ${#raw} -ne 12 ]]; then echo "error: random generation failed" >&2; exit 1; fi
    code="GV-${raw:0:4}-${raw:4:4}-${raw:8:4}"
    hash=$(printf '%s' "$code" | shasum -a 256 | awk '{print $1}')
    if [[ -n "$expires" ]]; then
      run "INSERT INTO promo_codes (code_hash, label, tier, expires_at) VALUES ('$hash', '$label', 'full', '$expires')" > /dev/null
    else
      run "INSERT INTO promo_codes (code_hash, label, tier) VALUES ('$hash', '$label', 'full')" > /dev/null
    fi
    echo "Created full-access code for '$label'${expires:+ (expires $expires)}:"
    echo
    echo "    $code"
    echo
    echo "Hand it to ONE person — it binds to their first 3 devices. It is stored only as a"
    echo "hash and cannot be shown again. Revoke anytime: scripts/promo.sh revoke $label"
    ;;
  list)
    run "SELECT p.label, p.tier, p.active, p.expires_at, COUNT(c.device_id) AS devices
         FROM promo_codes p LEFT JOIN promo_claims c ON c.code_hash = p.code_hash
         GROUP BY p.code_hash ORDER BY p.tier DESC, p.label"
    ;;
  revoke)
    require_label "${2:-}"
    run "UPDATE promo_codes SET active = 0 WHERE label = '$2'" > /dev/null
    echo "Revoked '$2' — stops minting sessions now; existing sessions lapse within 1 h."
    ;;
  enable)
    require_label "${2:-}"
    run "UPDATE promo_codes SET active = 1 WHERE label = '$2'" > /dev/null
    echo "Re-enabled '$2'."
    ;;
  unclaim)
    require_label "${2:-}"
    run "DELETE FROM promo_claims WHERE code_hash = $(hash_of_label_sql "$2")" > /dev/null
    echo "Freed all device slots for '$2' — its next redeeming devices claim them afresh."
    ;;
  delete)
    require_label "${2:-}"
    run "DELETE FROM promo_claims WHERE code_hash = $(hash_of_label_sql "$2")" > /dev/null
    run "DELETE FROM promo_codes WHERE label = '$2'" > /dev/null
    echo "Deleted code '$2' and its claims."
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
