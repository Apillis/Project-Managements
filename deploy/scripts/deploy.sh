#!/usr/bin/env bash
# Deploy a tagged version:  deploy.sh v1.0.0
#   1. checkout the tag   2. backup (pre-deploy)   3. migrations
#   4. rebuild and restart pm-web / notifier / caddy
# Rollback: deploy.sh <previous tag>  AND, if a migration ran, restore.sh <pre-deploy dump>
source "$(dirname "$0")/common.sh"
tag="${1:?usage: deploy.sh <git tag, e.g. v1.0.0>}"

log "checking out $tag"
git -C "$APP" fetch --tags --quiet
git -C "$APP" checkout --quiet "$tag"

"$APP/deploy/scripts/backup.sh" pre-deploy
"$APP/deploy/scripts/migrate.sh"

log "building and starting services"
compose up -d --build pm-web notifier caddy
compose ps
log "deployed $tag — open https://${PM_DOMAIN:-pm.apillis.lan} and press Ctrl+F5"
