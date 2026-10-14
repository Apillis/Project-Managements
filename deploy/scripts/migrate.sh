#!/usr/bin/env bash
# Apply new SQL migrations (supabase/migrations/*.sql) in order, each in one
# transaction. Applied versions are recorded in supabase_migrations.schema_migrations
# (same table the Supabase CLI uses), so a file is never applied twice.
source "$(dirname "$0")/common.sh"

psql_db -q <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL

applied=$(psql_db -At -c "select version from supabase_migrations.schema_migrations")
count=0
for f in "$APP"/supabase/migrations/*.sql; do
  base=$(basename "$f" .sql)
  version="${base%%_*}"
  name="${base#*_}"
  if grep -qx "$version" <<<"$applied"; then continue; fi
  log "applying $base"
  { echo "begin;"; cat "$f"; echo; echo "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$name');"; echo "commit;"; } | psql_db -q
  count=$((count + 1))
done
log "migrations done ($count new)"
