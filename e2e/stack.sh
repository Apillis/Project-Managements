#!/usr/bin/env bash
# Starts a real Supabase-like backend WITHOUT Docker for end-to-end tests:
#   PostgreSQL (existing) + GoTrue (auth) + PostgREST (rest) + vite preview (proxy)
#   bash stack.sh up | down
# Binaries are downloaded once into $E2E_BIN (default /opt/e2e).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="${E2E_BIN:-/opt/e2e}"
STATE="$HERE/.stack"
PGURL="${PGURL:-postgresql://postgres:postgres@localhost:5432}"
DB=pm_e2e
JWT_SECRET="e2e-super-secret-jwt-token-with-at-least-32-characters"
mkdir -p "$STATE" "$BIN"

down() {
  for p in "$STATE"/*.pid; do [[ -f "$p" ]] && kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; done
}

if [[ "${1:-up}" == "down" ]]; then down; exit 0; fi
down

# ---------------------------------------------------------------- binaries
if [[ ! -x "$BIN/auth" ]]; then
  curl -fsSL -o /tmp/auth.tgz https://github.com/supabase/auth/releases/download/v2.180.0/auth-v2.180.0-x86.tar.gz
  tar -C "$BIN" -xzf /tmp/auth.tgz
fi
if [[ ! -x "$BIN/postgrest" ]]; then
  curl -fsSL -o /tmp/pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
  tar -C "$BIN" -xJf /tmp/pgrst.tar.xz
fi

# ---------------------------------------------------------------- database
psql "$PGURL/postgres" -q -v ON_ERROR_STOP=1 <<SQL
drop database if exists $DB with (force);
create database $DB;
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login password 'authpass' noinherit; end if;
end \$\$;
grant anon, authenticated, service_role to authenticator;
SQL
psql "$PGURL/$DB" -q -c "create schema if not exists auth"

export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="$PGURL/$DB?search_path=auth"
export GOTRUE_DB_NAMESPACE=auth
export GOTRUE_API_HOST=127.0.0.1
export PORT=9999
export API_EXTERNAL_URL=http://localhost:4173/auth/v1
export GOTRUE_SITE_URL=http://localhost:4173
export GOTRUE_JWT_SECRET="$JWT_SECRET"
export GOTRUE_JWT_EXP=3600
export GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
export GOTRUE_MAILER_AUTOCONFIRM=true
export GOTRUE_LOG_LEVEL=warn
"$BIN/auth" migrate > "$STATE/auth-migrate.log" 2>&1

psql "$PGURL/$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/db-tests/supabase_stub.sql" > /dev/null 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do psql "$PGURL/$DB" -q -v ON_ERROR_STOP=1 -f "$f" > /dev/null; done
psql "$PGURL/$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/seed.sql" > /dev/null
psql "$PGURL/$DB" -q -c "grant usage on schema auth to authenticator; notify pgrst, 'reload schema';"

# ---------------------------------------------------------------- services
nohup "$BIN/auth" serve > "$STATE/auth.log" 2>&1 & echo $! > "$STATE/auth.pid"

cat > "$STATE/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authpass@localhost:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3000
CONF
nohup "$BIN/postgrest" "$STATE/postgrest.conf" > "$STATE/postgrest.log" 2>&1 & echo $! > "$STATE/postgrest.pid"

# anon key for the web build
ANON=$(node -e "
const c=require('crypto');const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const h=b({alg:'HS256',typ:'JWT'}),p=b({role:'anon',iss:'supabase',iat:1700000000,exp:2000000000});
console.log(h+'.'+p+'.'+c.createHmac('sha256','$JWT_SECRET').update(h+'.'+p).digest('base64url'))")

cd "$ROOT/web"
VITE_SUPABASE_URL=http://localhost:4173 VITE_SUPABASE_ANON_KEY="$ANON" npx vite build > "$STATE/build.log" 2>&1
PM_E2E=1 nohup npx vite preview --port 4173 --strictPort > "$STATE/preview.log" 2>&1 & echo $! > "$STATE/preview.pid"

for i in $(seq 1 40); do
  if curl -fs http://localhost:4173/ >/dev/null && curl -fs http://localhost:4173/auth/v1/health >/dev/null \
     && curl -fs -H "apikey: $ANON" http://localhost:4173/rest/v1/ >/dev/null; then
    echo "stack up: http://localhost:4173"; exit 0
  fi
  sleep 0.5
done
echo "stack failed to start"; tail -n 20 "$STATE"/*.log; exit 1
