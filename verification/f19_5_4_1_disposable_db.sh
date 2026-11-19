#!/usr/bin/env bash
# F19.5.4.1 security hardening and F19.5.4.2 event provenance: end-to-end
# check in a DISPOSABLE database.
#
#   bash verification/f19_5_4_1_disposable_db.sh <supabase-postgres-image>
#
# <supabase-postgres-image> is the image the local Supabase stack runs, for
# example the image ID shown by:
#   docker inspect <local-db-container> --format '{{.Image}}'
#
# The script never connects to the local stack. It starts a new container
# from the image (no volume or port mappings, removed on exit), then:
#   1. adds a minimal stand-in for the storage-api schema (storage.buckets,
#      storage.objects, storage.foldername), which the first migration uses;
#   2. applies every migration ordered before the hardening migration;
#   3. seeds pre-hardening history: requests with fixed created_at values,
#      and a client-inserted event claiming "source": "db_trigger", which the
#      old policies allowed;
#   4. records a hash of every request's (id, created_at) and of every
#      workflow event, applies the hardening migration and every later one
#      (including F19.5.4.2), and requires both hashes to be unchanged (no
#      historical timestamp or event is rewritten);
#   5. runs verification/f19_5_4_1_security_hardening.sql and
#      verification/f19_5_4_2_event_provenance.sql against the final schema;
#   6. re-runs the existing F19.2 verification scripts against the hardened
#      schema to show the workflow paths they cover still work.

set -euo pipefail

IMAGE="${1:?usage: $0 <supabase-postgres-image>}"
NAME="f19-5-4-1-disposable-$$"
HARDENING="20261119120100_f19_5_4_1_security_hardening.sql"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"

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

apply() { echo "   $(basename "$1")"; docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 --single-transaction < "$1" >/dev/null; }

echo "== migrations before the hardening migration"
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(ls "$MIGRATIONS"/*.sql | sort)
for f in "${FILES[@]}"; do
  [[ "$(basename "$f")" < "$HARDENING" ]] && apply "$f"
done

echo "== pre-hardening history"
as_owner <<'SQL'
INSERT INTO auth.users (id) VALUES ('f1954100-0000-4000-8000-0000000000aa') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.financial_requests (
  user_id, title, requester_email, department, funding_source, amount, needed_by, priority,
  description, status, created_at, metadata
)
SELECT 'f1954100-0000-4000-8000-0000000000aa', 'F19.5.4.1 historical fixture', 'history@howard.edu', 'Finance',
       'department', 500, DATE '2027-01-01', 'medium', 'Created before the hardening migration', 'submitted',
       ts, '{}'::JSONB
FROM unnest(ARRAY[TIMESTAMPTZ '2025-03-04T05:06:07.123456Z', TIMESTAMPTZ '2026-10-31T23:59:59.999999Z']) AS ts;
-- A requester impersonating a database-generated event through the old
-- owner INSERT policy (possible before F19.5.4.2).
BEGIN;
SELECT set_config('request.jwt.claim.sub', 'f1954100-0000-4000-8000-0000000000aa', true) \g /dev/null
SET LOCAL ROLE authenticated;
INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
SELECT id, 'f1954100-0000-4000-8000-0000000000aa', 'note', 'Forged before F19.5.4.2', '{"source": "db_trigger"}'::JSONB
FROM public.financial_requests WHERE title = 'F19.5.4.1 historical fixture' ORDER BY created_at LIMIT 1;
COMMIT;
SQL

snapshot() {
  as_owner -At -c "SELECT 'requests ' || count(*) || ':' || md5(string_agg(id::TEXT || '@' || created_at::TEXT, ',' ORDER BY id)) FROM public.financial_requests" \
               -c "SELECT 'events ' || count(*) || ':' || md5(string_agg(to_jsonb(e)::TEXT, ',' ORDER BY id)) FROM public.workflow_events e" | tr '\n' ' '
}
BEFORE="$(snapshot)"

echo "== hardening migration (and any later migrations)"
for f in "${FILES[@]}"; do
  [[ "$(basename "$f")" < "$HARDENING" ]] || apply "$f"
done

AFTER="$(snapshot)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "FAIL: requests or events changed during the migrations ($BEFORE -> $AFTER)" >&2
  exit 1
fi
echo "   request (id, created_at) and event snapshots unchanged: $AFTER"

echo "== F19.5.4.1 regression checks"
as_owner -v disposable=1 < "$ROOT/verification/f19_5_4_1_security_hardening.sql" 2>&1 | grep -E "PASS|passed|FAIL|ERROR" || true
as_owner -v disposable=1 < "$ROOT/verification/f19_5_4_1_security_hardening.sql" >/dev/null 2>&1

echo "== F19.5.4.2 event provenance checks"
as_owner -v disposable=1 < "$ROOT/verification/f19_5_4_2_event_provenance.sql" 2>&1 | grep -E "PASS|passed|FAIL|ERROR" || true
as_owner -v disposable=1 < "$ROOT/verification/f19_5_4_2_event_provenance.sql" >/dev/null 2>&1

echo "== existing F19.2 verification against the hardened schema"
as_owner < "$ROOT/verification/f19_2_status_guard.sql" >/dev/null && echo "   f19_2_status_guard.sql passed"
as_owner < "$ROOT/verification/f19_2_regression.sql" >/dev/null && echo "   f19_2_regression.sql passed"
bash "$ROOT/verification/f19_2_status_guard_concurrency.sh" "$NAME" >/dev/null && echo "   f19_2_status_guard_concurrency.sh passed"

echo "F19.5.4.1 and F19.5.4.2 disposable-database verification passed."
