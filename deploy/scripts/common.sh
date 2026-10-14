#!/usr/bin/env bash
# Shared settings for the server scripts.
set -euo pipefail
ROOT="${APILLIS_ROOT:-/opt/apillis-pm}"
SUPA="$ROOT/supabase"
APP="$ROOT/pm-app"
# load supabase/.env (POSTGRES_PASSWORD, BACKUP_DIR …)
if [[ -f "$SUPA/.env" ]]; then set -a; source "$SUPA/.env"; set +a; fi
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
compose() { (cd "$SUPA" && docker compose -f docker-compose.yml -f "$APP/deploy/compose.apillis.yml" "$@"); }
# APILLIS_PSQL_URL lets the scripts run against any PostgreSQL (CI / tests)
psql_db() {
  if [[ -n "${APILLIS_PSQL_URL:-}" ]]; then psql -v ON_ERROR_STOP=1 "$APILLIS_PSQL_URL" "$@";
  else compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-postgres}" "$@"; fi
}
log() { echo "[$(date '+%F %T')] $*"; }
