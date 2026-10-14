#!/usr/bin/env bash
# Restore a backup made by backup.sh (database + storage files).
#   restore.sh /opt/apillis-pm/backups/pm_20261014-2330_daily.dump
# Use it also to roll back a failed migration (restore the pre-deploy dump).
source "$(dirname "$0")/common.sh"
dump="${1:?usage: restore.sh <file.dump>}"
[[ -f "$dump" ]] || { echo "not found: $dump"; exit 1; }
read -r -p "This REPLACES the current data with $(basename "$dump"). Type RESTORE to continue: " ok
[[ "$ok" == "RESTORE" ]] || { echo "aborted"; exit 1; }

log "stopping app services"
compose stop pm-web notifier rest auth realtime storage || true
log "restoring database"
compose exec -T db pg_restore -U postgres -d "${POSTGRES_DB:-postgres}" --clean --if-exists --no-owner < "$dump" || log "pg_restore reported warnings (check above)"
st="${dump%.dump}_storage.tgz"
if [[ -f "$st" ]]; then
  log "restoring storage files"
  rm -rf "$SUPA/volumes/storage.old" && mv "$SUPA/volumes/storage" "$SUPA/volumes/storage.old" || true
  tar -C "$SUPA/volumes" -xzf "$st"
fi
log "starting services"
compose up -d
log "restore finished — open the app and check the data"
