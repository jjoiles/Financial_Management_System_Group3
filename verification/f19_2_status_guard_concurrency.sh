#!/usr/bin/env bash
# F19.2 decision status guard: concurrency checks against the local stack.
#
#   npx supabase migration up
#   bash verification/f19_2_status_guard_concurrency.sh <local-db-container>
#
# Each case runs two real database sessions. Session A takes the request row
# lock inside a workflow function and holds its transaction open; session B
# starts while A holds the lock. A third session confirms that B is blocked on
# a lock (so the race is real, not a timing accident), then the script checks
# B's error and the final committed state.
#
# Fixtures must be committed to be visible across sessions. They use dedicated
# user ids and are deleted on exit, including after a failure.

set -euo pipefail

CONTAINER="${1:?usage: $0 <local-db-container>}"
OWNER="f1930000-0000-4000-8000-000000000001"
REVIEWER="f1930000-0000-4000-8000-000000000002"
HOLD_SECONDS=4
WORK_DIR="$(mktemp -d)"

psql_db() {
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_db >/dev/null <<SQL || true
DELETE FROM public.financial_requests WHERE user_id IN ('$OWNER', '$REVIEWER');
DELETE FROM public.user_roles WHERE user_id IN ('$OWNER', '$REVIEWER');
DELETE FROM auth.users WHERE id IN ('$OWNER', '$REVIEWER');
SQL
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

routing_json() {
  # $1 queue, $2 label
  printf '{"primaryQueue":"%s","primaryLabel":"%s","approvalChain":[{"step":1,"queue":"%s","label":"%s"}],"flags":[],"rulesVersion":"f19-status-guard-concurrency"}' \
    "$1" "$2" "$1" "$2"
}

# Creates a submitted single-stage request with its stage 1 active; prints its id.
new_request() {
  psql_db <<SQL
SELECT set_config('request.jwt.claim.sub', '$OWNER', false) \gset ignored_
INSERT INTO public.financial_requests (
  user_id, title, requester_email, department, funding_source, amount,
  needed_by, priority, description, status, routed_to, metadata
) VALUES (
  '$OWNER', 'F19.2 concurrency fixture', 'owner@howard.edu', 'Finance', 'department', 1000,
  current_date + 30, 'medium', 'Concurrency fixture', 'submitted', 'Department Budget Reviewer',
  jsonb_build_object('routing', '$(routing_json department_budget "Department Budget Reviewer")'::jsonb)
) RETURNING id AS req \gset
SELECT public.f16_start_initial_approval_stage(:'req') IS NOT NULL AS started \gset
\echo :req
SQL
}

active_stage() {
  psql_db -c "SELECT id FROM public.approval_stage_tracking WHERE request_id = '$1' AND status = 'active'"
}

decision_sql() {
  # $1 request, $2 stage, $3 approve|reject
  echo "SELECT set_config('request.jwt.claim.sub', '$REVIEWER', true);
SET LOCAL ROLE authenticated;
SELECT public.f16_record_approval_decision('$1', '$2', '$3', NULL);"
}

amend_sql() {
  # $1 request, $2 caller
  echo "SELECT set_config('request.jwt.claim.sub', '$2', true);
SET LOCAL ROLE authenticated;
SELECT public.f19_amend_request_workflow('$1', 2000, 'department', NULL, NULL, NULL,
  'Provost Finance Office', '$(routing_json provost_finance "Provost Finance Office")'::jsonb, 'concurrency check');"
}

direct_status_sql() {
  # $1 request, $2 new status
  echo "SELECT set_config('request.jwt.claim.sub', '$REVIEWER', true);
SET LOCAL ROLE authenticated;
UPDATE public.financial_requests SET status = '$2' WHERE id = '$1';"
}

# race NAME HOLDER_SQL CONTENDER_SQL EXPECTED_CONTENDER_ERROR
race() {
  local name="$1" holder_sql="$2" contender_sql="$3" expected="$4"
  local a_out="$WORK_DIR/$name.a" b_out="$WORK_DIR/$name.b"

  printf "SET application_name = 'f19_guard_%s_a';\nBEGIN;\n%s\nSELECT pg_sleep(%s);\nCOMMIT;\n" \
    "$name" "$holder_sql" "$HOLD_SECONDS" | psql_db >"$a_out" 2>&1 &
  local a_pid=$!
  sleep 1

  printf "SET application_name = 'f19_guard_%s_b';\nBEGIN;\n%s\nCOMMIT;\n" \
    "$name" "$contender_sql" | psql_db >"$b_out" 2>&1 &
  local b_pid=$!
  sleep 1.5

  local waiting
  waiting=$(psql_db -c "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name = 'f19_guard_${name}_b' AND wait_event_type = 'Lock'")
  [[ "$waiting" == "1" ]] || fail "$name: session B was not blocked on a lock while A held it (waiting=$waiting)"

  wait "$a_pid" || fail "$name: session A failed: $(cat "$a_out")"
  if wait "$b_pid"; then
    fail "$name: session B succeeded but should have failed: $(cat "$b_out")"
  fi
  grep -qF "$expected" "$b_out" || fail "$name: session B failed with an unexpected error: $(cat "$b_out")"
}

# expect_state NAME REQUEST "status|workflow_revision|stages|active_stages|amendments"
expect_state() {
  local actual
  actual=$(psql_db -c "SELECT fr.status || '|' || fr.workflow_revision || '|' ||
      (SELECT COUNT(*) FROM public.approval_stage_tracking s WHERE s.request_id = fr.id) || '|' ||
      (SELECT COUNT(*) FROM public.approval_stage_tracking s WHERE s.request_id = fr.id AND s.status = 'active') || '|' ||
      (SELECT COUNT(*) FROM public.request_workflow_amendments a WHERE a.request_id = fr.id)
    FROM public.financial_requests fr WHERE fr.id = '$2'")
  [[ "$actual" == "$3" ]] || fail "$1: expected final state $3, got $actual"
}

cleanup_rows_only() {
  psql_db >/dev/null <<SQL
DELETE FROM public.financial_requests WHERE user_id IN ('$OWNER', '$REVIEWER');
SQL
}

# ------------------------------------------------------------
cleanup_rows_only
psql_db >/dev/null <<SQL
INSERT INTO auth.users (id) VALUES ('$OWNER'), ('$REVIEWER') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('$REVIEWER', 'reviewer') ON CONFLICT (user_id, role) DO NOTHING;
SQL

# C1: a final decision holds the lock; an amendment waits, then is refused.
req=$(new_request)
stage=$(active_stage "$req")
race c1 "$(decision_sql "$req" "$stage" approve)" "$(amend_sql "$req" "$OWNER")" \
  "Only requests awaiting a decision can be amended. Current status: approved."
expect_state c1 "$req" "approved|1|1|0|0"
echo "PASS C1: decision first; the waiting amendment is refused and nothing is reopened"

# C2: an amendment holds the lock; a decision on the old stage waits, then is refused.
req=$(new_request)
stage=$(active_stage "$req")
race c2 "$(amend_sql "$req" "$OWNER")" "$(decision_sql "$req" "$stage" approve)" \
  "Approval stage revision does not match the current request revision."
expect_state c2 "$req" "under_review|2|2|1|1"
echo "PASS C2: amendment first; the waiting decision on the cancelled stage is refused"

# C3: two decisions on the same stage; the second is refused.
req=$(new_request)
stage=$(active_stage "$req")
race c3 "$(decision_sql "$req" "$stage" approve)" "$(decision_sql "$req" "$stage" reject)" \
  "Request is not open for approval. Current status: approved."
expect_state c3 "$req" "approved|1|1|0|0"
echo "PASS C3: concurrent decisions; the second is refused"

# C4: a decision holds the lock; a direct status update waits, then is refused.
req=$(new_request)
stage=$(active_stage "$req")
race c4 "$(decision_sql "$req" "$stage" approve)" "$(direct_status_sql "$req" rejected)" \
  "Request status approved is final and cannot change to rejected."
expect_state c4 "$req" "approved|1|1|0|0"
echo "PASS C4: decision first; the waiting direct update cannot overwrite it"

echo "F19.2 decision status guard concurrency: all checks passed."
