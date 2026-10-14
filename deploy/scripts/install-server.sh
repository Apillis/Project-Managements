#!/usr/bin/env bash
# One-time installation on a fresh Ubuntu Server 24.04 (run as a sudo user):
#   curl -fsSL <raw url>/deploy/scripts/install-server.sh | bash -s -- v1.0.0
# Steps: Docker, Supabase self-host (pinned), this repo, secrets, firewall, cron, first deploy.
set -euo pipefail
TAG="${1:-main}"
ROOT="${APILLIS_ROOT:-/opt/apillis-pm}"
REPO="${APILLIS_REPO:-https://github.com/Apillis/Project-Managements.git}"
SUPABASE_REF="${SUPABASE_REF:-master}"   # pin to a tested commit/tag in production

sudo timedatectl set-timezone Asia/Ho_Chi_Minh || true
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
sudo apt-get update -y && sudo apt-get install -y git rsync ufw nodejs

sudo mkdir -p "$ROOT" && sudo chown "$USER" "$ROOT"
cd "$ROOT"
[[ -d pm-app ]] || git clone "$REPO" pm-app
if [[ ! -d supabase ]]; then
  git clone --depth 1 --branch "$SUPABASE_REF" https://github.com/supabase/supabase /tmp/supabase-src
  cp -r /tmp/supabase-src/docker supabase && rm -rf /tmp/supabase-src
  cp supabase/.env.example supabase/.env
  # fresh secrets (replace the demo defaults)
  node pm-app/deploy/scripts/gen-keys.mjs | while IFS='=' read -r k v; do
    sed -i "s|^${k}=.*|${k}=${v}|" supabase/.env
  done
  cat pm-app/deploy/env.apillis.example >> supabase/.env
  echo ">>> Edit $ROOT/supabase/.env: SITE_URL, API_EXTERNAL_URL, SUPABASE_PUBLIC_URL=https://pm.apillis.lan, SMTP, PM_DOMAIN, ADMIN_IP"
fi
mkdir -p "$ROOT/backups"

# firewall: only SSH (from admin) and HTTP/HTTPS
sudo ufw default deny incoming
sudo ufw allow 80,443/tcp
sudo ufw allow from "${ADMIN_IP:-192.168.1.0/24}" to any port 22 proto tcp
sudo ufw --force enable

# nightly backup 23:30
( crontab -l 2>/dev/null | grep -v apillis-backup ; echo "30 23 * * * $ROOT/pm-app/deploy/scripts/backup.sh >> $ROOT/backups/backup.log 2>&1 # apillis-backup" ) | crontab -

echo ">>> After editing .env run:  $ROOT/pm-app/deploy/scripts/deploy.sh $TAG"
echo ">>> First start of Supabase:  cd $ROOT/supabase && docker compose -f docker-compose.yml -f ../pm-app/deploy/compose.apillis.yml up -d"
