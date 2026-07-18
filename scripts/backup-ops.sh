#!/bin/bash
# backup-ops.sh — export the one IRREPLACEABLE database (MS2-FR-30d).
#
# Content databases and media buckets are reproducible from pipeline sources; the
# PROD OPS database (devices, promo codes/claims, submissions, feedback, purchase
# bindings) is not. This script exports it, and rehearses the restore — because an
# untested backup is not a backup (project rule).
#
#   scripts/backup-ops.sh backup            export → backups/ops-prod-<UTC>.sql
#   scripts/backup-ops.sh restore-drill     restore the LATEST backup into a scratch
#                                           D1 database, compare per-table row counts
#                                           against live, then delete the scratch DB
#   scripts/backup-ops.sh install-schedule  install a weekly launchd agent (Mon 09:00)
#
# backups/ is gitignored: it contains device identifiers — never commit it.

set -euo pipefail
cd "$(dirname "$0")/.."

DB="german-ops-prod"
SCRATCH_DB="german-ops-restore-drill"
BACKUP_DIR="backups"
TABLES=(devices promo_codes promo_claims submissions feedback search_usage transaction_devices)

wr() { (cd read-worker && npx wrangler "$@"); }

counts() { # db-name → "table=n table=n ..."
  local db="$1" out=""
  for t in "${TABLES[@]}"; do
    local n
    n=$(wr d1 execute "$db" --remote --json --command "SELECT COUNT(*) AS n FROM $t" 2>/dev/null \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo "?")
    out+="$t=$n "
  done
  echo "$out"
}

case "${1:-}" in
  backup)
    mkdir -p "$BACKUP_DIR"
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    file="$BACKUP_DIR/ops-prod-$ts.sql"
    wr d1 export "$DB" --remote --output "../$file" >/dev/null
    echo "✅ exported $DB → $file ($(du -h "$file" | cut -f1 | tr -d ' '))"
    echo "   live counts: $(counts "$DB")"
    ;;

  restore-drill)
    latest=$(ls -t "$BACKUP_DIR"/ops-prod-*.sql 2>/dev/null | head -1)
    [[ -n "$latest" ]] || { echo "❌ no backup found — run 'backup' first" >&2; exit 1; }
    echo "── drill: restoring $latest into scratch database $SCRATCH_DB"
    wr d1 create "$SCRATCH_DB" >/dev/null 2>&1 || true   # reuse if it survived a failed drill
    wr d1 execute "$SCRATCH_DB" --remote --file "../$latest" -y >/dev/null
    live=$(counts "$DB"); restored=$(counts "$SCRATCH_DB")
    echo "   live:     $live"
    echo "   restored: $restored"
    wr d1 delete "$SCRATCH_DB" -y >/dev/null 2>&1 || echo "⚠️  could not delete $SCRATCH_DB — remove manually"
    if [[ "$live" == "$restored" ]]; then
      echo "✅ restore drill PASSED (counts match; scratch DB deleted)"
    else
      echo "⚠️  counts differ — expected if live changed since the backup; inspect above"
    fi
    ;;

  install-schedule)
    plist="$HOME/Library/LaunchAgents/com.germanvocab.ops-backup.plist"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.germanvocab.ops-backup</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$(pwd)/scripts/backup-ops.sh</string>
    <string>backup</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$(pwd)/backups/backup.log</string>
  <key>StandardErrorPath</key><string>$(pwd)/backups/backup.log</string>
</dict></plist>
PLIST
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "✅ weekly backup scheduled (Mon 09:00 local) — log: backups/backup.log"
    ;;

  *) echo "usage: scripts/backup-ops.sh <backup|restore-drill|install-schedule>" >&2; exit 1 ;;
esac
