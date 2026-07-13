#!/bin/bash
# promo.sh — admin tool for PERSONAL full-access codes (app spec UA-FR-4b).
#
# One code per person. A full-tier code binds to the first PROMO_DEVICE_CAP (2) attested
# devices that redeem it (promo_claims, enforced in src/entitlement.ts claimPromoDevice);
# anyone else gets "code already in use". Revocation is per code, i.e. per person, and
# takes effect within the session TTL (1 h).
#
# Usage (from anywhere; talks to the REMOTE D1 both workers share):
#   scripts/promo.sh create <label> [expires-ISO8601]   mint a code for one person, print it ONCE
#   scripts/promo.sh list                                all codes + tier/active/expiry/claimed devices
#   scripts/promo.sh revoke <label>                      disable (active=0) — the person loses access
#   scripts/promo.sh enable <label>                      re-enable a revoked code
#   scripts/promo.sh unclaim <label>                     free ALL device slots (e.g. after a reinstall
#                                                        burned one) — the code itself stays valid
#   scripts/promo.sh delete <label>                      remove the code and its claims entirely
#
# The plaintext code is printed exactly once at create time and stored ONLY as a SHA-256
# hash — it cannot be recovered later. Codes use A-Z/2-9 without I/O/0/1 (unambiguous to
# read aloud) and match the app's input rules (letters/digits/dash, <= 64 chars).

set -euo pipefail
cd "$(dirname "$0")/.."   # read-worker/, where wrangler.toml lives

DB="german-vocabulary"

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
    echo "Hand it to ONE person — it binds to their first 2 devices. It is stored only as a"
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
