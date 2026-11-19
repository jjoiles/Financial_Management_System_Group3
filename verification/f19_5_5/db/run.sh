#!/usr/bin/env bash
# F19.5.5 database mode, in a DISPOSABLE database.
#
#   bash verification/f19_5_5/db/run.sh <supabase-postgres-image> [output-dir]
#
# <supabase-postgres-image> is the image the local Supabase stack runs:
#   docker inspect <local-db-container> --format '{{.Image}}'
#
# The script never connects to the local stack. It starts a new container from
# the image (no volume or port mappings, removed on exit), applies the whole
# migration history (including the F19.5.4.1 and F19.5.4.2 hardening
# migrations), and for each database-backed scenario in
# fixtures/db-scenarios.json:
#   1. seeds the rows (db/seed.sql),
#   2. exports the loader columns as JSON as the authenticated reviewer in an
#      America/New_York session (db/export.sql),
#   3. runs the independent verification/f19_5_2_metric_verification.sql for
#      October, November and December 2026.
# Then it stops the container and runs the vitest suite in database mode.

set -euo pipefail

IMAGE="${1:?usage: $0 <supabase-postgres-image> [output-dir]}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/verification/f19_5_5"
OUT="${2:-$(mktemp -d)}"
NAME="f19-5-5-disposable-$$"
OWNER="f1955000-0000-4000-8000-000000000001"
REVIEWER="f1955000-0000-4000-8000-000000000002"
mkdir -p "$OUT/db"

cleanup() { docker stop "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

as_owner() { docker exec -i "$NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
as_bootstrap() { docker exec -i "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "== starting disposable container $NAME"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "$IMAGE" \
  -p 5432 -c listen_addresses='*' >/dev/null
for _ in $(seq 1 90); do
  docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 2
done
sleep 2
docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null

echo "== storage-api stand-in"
as_bootstrap <<'SQL'
GRANT USAGE ON SCHEMA storage TO postgres;
CREATE TABLE IF NOT EXISTS storage.buckets (id TEXT PRIMARY KEY, name TEXT NOT NULL, public BOOLEAN DEFAULT false);
CREATE TABLE IF NOT EXISTS storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT, owner UUID);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS
  $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
ALTER TABLE storage.buckets OWNER TO postgres;
ALTER TABLE storage.objects OWNER TO postgres;
SQL

echo "== migration history (in order)"
# Record applied migrations the way the Supabase CLI does; the F19.5.2 SQL reports the latest one.
as_owner <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version TEXT PRIMARY KEY, name TEXT);
SQL
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(ls "$ROOT"/supabase/migrations/*.sql | sort)
for f in "${FILES[@]}"; do
  BASE="$(basename "$f" .sql)"
  echo "   $BASE"
  docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -d postgres -X -q \
    -v ON_ERROR_STOP=1 --single-transaction < "$f" >/dev/null
  as_owner -c "INSERT INTO supabase_migrations.schema_migrations VALUES ('${BASE%%_*}', '${BASE#*_}')"
done
as_owner -At -c "SELECT 'recorded ' || count(*) || ' migrations, latest ' || max(version) FROM supabase_migrations.schema_migrations"
as_owner -At <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('f19_assign_request_created_at',
      'zz_f19_guard_request_created_at', 'f19_guard_workflow_event_provenance', 'zz_f19_guard_request_status')) <> 4 THEN
    RAISE EXCEPTION 'hardening triggers missing: the migration history did not apply as expected';
  END IF;
END $$;
SQL
echo "   F19.2 and F19.5.4 triggers present"

echo "== fixture users"
as_owner <<SQL
INSERT INTO auth.users (id) VALUES ('$OWNER'), ('$REVIEWER') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('$REVIEWER', 'reviewer') ON CONFLICT (user_id, role) DO NOTHING;
SQL

for KEY in S5 S58 SX; do
  echo "== scenario $KEY"
  DATA="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["scenarios"][sys.argv[2]]))' \
    "$HERE/fixtures/db-scenarios.json" "$KEY")"
  as_bootstrap -v disposable=1 -v data="$DATA" -v owner="$OWNER" -c "SET client_min_messages = warning" -f - < "$HERE/db/seed.sql" >/dev/null
  as_owner -At -v reviewer="$REVIEWER" < "$HERE/db/export.sql" | grep '^{' > "$OUT/db/export_$KEY.json"
  echo "   exported $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d["financial_requests"]), "requests,", len(d["approval_stage_tracking"]), "stages")' "$OUT/db/export_$KEY.json")"
  for PERIOD in oct:2026-10-01:2026-11-01 nov:2026-11-01:2026-12-01 dec:2026-12-01:2027-01-01; do
    IFS=: read -r LABEL START END <<<"$PERIOD"
    as_owner -At -F $'\t' -v period_start="${START}T00:00:00Z" -v period_end_exclusive="${END}T00:00:00Z" \
      < "$ROOT/verification/f19_5_2_metric_verification.sql" > "$OUT/db/sql_${KEY}_${LABEL}.tsv"
  done
  echo "   independent SQL ran for oct, nov, dec"
done

cleanup
trap - EXIT

echo "== vitest (database mode)"
cd "$ROOT"
F19_5_5_DB_DIR="$OUT/db" F19_5_5_REPORT_DIR="$OUT/report" npx vitest run verification/f19_5_5
echo "Report: $OUT/report/report.md"
