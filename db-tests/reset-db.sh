#!/usr/bin/env bash
# Recreate a clean test database and apply the Supabase stub + all migrations.
set -euo pipefail
: "${PGURL:=postgresql://postgres:postgres@localhost:5432}"
DB="${TEST_DB:-pm_test}"
HERE="$(cd "$(dirname "$0")" && pwd)"
psql "$PGURL/postgres" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql "$PGURL/$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/supabase_stub.sql"
for f in "$HERE"/../supabase/migrations/*.sql; do
  psql "$PGURL/$DB" -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null || { echo "FAILED: $f"; exit 1; }
done
echo "Database $DB ready"
