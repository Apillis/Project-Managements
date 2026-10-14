#!/usr/bin/env bash
# Nightly / pre-deploy backup: database dump + storage files.
#   backup.sh            → daily backup (keeps 14 days, Sunday copy kept 8 weeks)
#   backup.sh pre-deploy → kept 5 most recent
# 3-2-1: server disk + NAS (NAS_TARGET, rsync) + off-site (RCLONE_REMOTE, Sundays)
source "$(dirname "$0")/common.sh"
label="${1:-daily}"
stamp=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/pm_${stamp}_${label}"

log "dumping database → ${file}.dump"
compose exec -T db pg_dump -U postgres -d "${POSTGRES_DB:-postgres}" -Fc --no-owner \
  -n public -n app -n auth -n storage -n supabase_migrations > "${file}.dump"
test -s "${file}.dump"

if [[ -d "$SUPA/volumes/storage" ]]; then
  log "archiving storage files"
  tar -C "$SUPA/volumes" -czf "${file}_storage.tgz" storage
fi

# retention
if [[ "$label" == "pre-deploy" ]]; then
  ls -1t "$BACKUP_DIR"/pm_*_pre-deploy.dump 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f" "${f%.dump}_storage.tgz"; done
else
  if [[ "$(date +%u)" == "7" ]]; then cp "${file}.dump" "$BACKUP_DIR/pm_${stamp}_weekly.dump"; fi
  find "$BACKUP_DIR" -name 'pm_*_daily*' -mtime +14 -delete
  ls -1t "$BACKUP_DIR"/pm_*_weekly.dump 2>/dev/null | tail -n +9 | xargs -r rm -f
fi

if [[ -n "${NAS_TARGET:-}" ]]; then
  log "rsync → $NAS_TARGET"
  rsync -a --delete "$BACKUP_DIR/" "$NAS_TARGET/" || log "WARNING: NAS copy failed"
fi
if [[ -n "${RCLONE_REMOTE:-}" && "$(date +%u)" == "7" && "$label" == "daily" ]]; then
  log "rclone weekly copy → $RCLONE_REMOTE"
  rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --include 'pm_*_weekly.dump' || log "WARNING: off-site copy failed"
fi
log "backup finished: ${file}.dump"
