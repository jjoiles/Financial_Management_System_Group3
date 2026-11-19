-- F19.2 decision status guard regression checks
-- (supabase/migrations/20261119072711_f19_2_decision_status_guard.sql).
--
-- Run against the local stack only, after the migration is applied:
--   npx supabase migration up
--   docker exec -i <local-db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X < verification/f19_2_status_guard.sql
--
-- Every test section runs in its own transaction and ends with ROLLBACK, so
-- no rows are left behind. Helpers are session-scoped temporary functions.
-- The connection must be the table owner (postgres on Supabase) and a member
-- of anon, authenticated and service_role, so API callers can be reproduced
-- with SET LOCAL ROLE exactly as PostgREST does.

\set ON_ERROR_STOP on

-- ------------------------------------------------------------
-- Session helpers (temporary; dropped when the session ends)
-- ------------------------------------------------------------

CREATE FUNCTION pg_temp.t_owner() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1920000-0000-4000-8000-000000000001'::UUID $$;
CREATE FUNCTION pg_temp.t_reviewer() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1920000-0000-4000-8000-000000000002'::UUID $$;
CREATE FUNCTION pg_temp.t_admin() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1920000-0000-4000-8000-000000000003'::UUID $$;
CREATE FUNCTION pg_temp.t_other() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1920000-0000-4000-8000-000000000004'::UUID $$;

-- Users and roles for one test transaction.
CREATE FUNCTION pg_temp.t_setup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id)
  VALUES (pg_temp.t_owner()), (pg_temp.t_reviewer()), (pg_temp.t_admin()), (pg_temp.t_other())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES
    (pg_temp.t_reviewer(), 'reviewer'::public.app_role),
    (pg_temp.t_admin(), 'admin'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
END;
$$;

-- Routing snapshot with an approval chain of p_steps stages.
CREATE FUNCTION pg_temp.t_routing(p_steps INTEGER, p_first_queue TEXT DEFAULT 'department_budget')
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  queues TEXT[] := ARRAY[p_first_queue, 'dean_office', 'cfo_office'];
  labels TEXT[] := ARRAY[
    CASE p_first_queue WHEN 'department_budget' THEN 'Department Budget Reviewer' ELSE 'Provost Finance Office' END,
    'Dean''s Office',
    'Office of the CFO'
  ];
  chain JSONB := '[]'::JSONB;
BEGIN
  FOR i IN 1..p_steps LOOP
    chain := chain || jsonb_build_array(jsonb_build_object('step', i, 'queue', queues[i], 'label', labels[i]));
  END LOOP;
  RETURN jsonb_build_object(
    'primaryQueue', queues[1], 'primaryLabel', labels[1], 'approvalChain', chain,
    'flags', jsonb_build_array(), 'rulesVersion', 'f19-status-guard-fixture'
  );
END;
$$;

-- A request inserted by the table owner (trusted), with p_steps routing steps.
CREATE FUNCTION pg_temp.t_request(
  p_status public.request_status DEFAULT 'submitted',
  p_steps INTEGER DEFAULT 1,
  p_revision INTEGER DEFAULT 1
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  routing JSONB := pg_temp.t_routing(p_steps);
  req_id UUID;
BEGIN
  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, workflow_revision, routed_to, metadata
  ) VALUES (
    pg_temp.t_owner(), 'F19.2 status guard fixture', 'owner@howard.edu', 'Finance',
    'department', 1000, current_date + 30, 'medium',
    'Fixture for decision status guard checks', p_status, p_revision,
    routing ->> 'primaryLabel', jsonb_build_object('routing', routing)
  )
  RETURNING id INTO req_id;
  RETURN req_id;
END;
$$;

-- Runs p_sql as p_role (NULL = the owner session) with auth.uid() = p_sub.
-- Fails unless it succeeds. Role and claims are reset afterwards.
CREATE FUNCTION pg_temp.t_exec(p_role TEXT, p_sub UUID, p_sql TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_sub::TEXT, ''), true);
  IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
  EXECUTE p_sql;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$$;

-- Runs p_sql as p_role with auth.uid() = p_sub and requires it to fail with
-- p_state (and, when given, a message containing p_fragment). A statement that
-- succeeds, including an UPDATE that matched no rows, fails the test. The
-- failed statement, the role switch and the claim are all rolled back with the
-- subtransaction.
CREATE FUNCTION pg_temp.t_expect_error(
  p_label TEXT, p_role TEXT, p_sub UUID, p_sql TEXT, p_state TEXT, p_fragment TEXT DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  succeeded BOOLEAN := FALSE;
  got_state TEXT;
  got_message TEXT;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(p_sub::TEXT, ''), true);
    IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
    EXECUTE p_sql;
    succeeded := TRUE;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_message = MESSAGE_TEXT;
  END;

  IF succeeded THEN
    RAISE EXCEPTION 'FAIL [%]: expected SQLSTATE %, but the statement succeeded.', p_label, p_state;
  END IF;
  IF got_state <> p_state OR (p_fragment IS NOT NULL AND position(p_fragment IN got_message) = 0) THEN
    RAISE EXCEPTION 'FAIL [%]: expected % "%", got % "%".', p_label, p_state, p_fragment, got_state, got_message;
  END IF;
END;
$$;

-- Starts SLA tracking (stage 1 of the current revision) as the owner.
CREATE FUNCTION pg_temp.t_start(p_request UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.t_exec(
    'authenticated', pg_temp.t_owner(),
    format('SELECT public.f16_start_initial_approval_stage(%L)', p_request)
  );
END;
$$;

-- Records a decision on the active stage through the RPC, as an authenticated
-- reviewer: the same path as the recordApprovalDecision server function.
CREATE FUNCTION pg_temp.t_decide(p_request UUID, p_decision TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  stage_id UUID;
BEGIN
  SELECT id INTO STRICT stage_id
  FROM public.approval_stage_tracking
  WHERE request_id = p_request AND status = 'active';
  PERFORM pg_temp.t_exec(
    'authenticated', pg_temp.t_reviewer(),
    format('SELECT public.f16_record_approval_decision(%L, %L, %L, NULL)', p_request, stage_id, p_decision)
  );
END;
$$;

-- SQL for a valid amendment: amount changes, re-routed to a one-step chain.
CREATE FUNCTION pg_temp.t_amend_sql(p_request UUID, p_amount NUMERIC DEFAULT 2000) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'SELECT public.f19_amend_request_workflow(%L, %s, %L, NULL, NULL, NULL, %L, %L::JSONB, %L)',
    p_request, p_amount, 'department', 'Provost Finance Office',
    pg_temp.t_routing(1, 'provost_finance')::TEXT, 'status guard regression'
  )
$$;

-- Everything an amendment or status change could touch, for no-side-effect checks.
CREATE FUNCTION pg_temp.t_snapshot(p_request UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'request', (SELECT to_jsonb(fr) - 'updated_at' FROM public.financial_requests fr WHERE fr.id = p_request),
    'stages', (SELECT COALESCE(jsonb_agg(to_jsonb(ast) - 'updated_at' ORDER BY ast.workflow_revision, ast.stage_order), '[]')
               FROM public.approval_stage_tracking ast WHERE ast.request_id = p_request),
    'amendments', (SELECT COUNT(*) FROM public.request_workflow_amendments a WHERE a.request_id = p_request),
    'events', (SELECT COUNT(*) FROM public.workflow_events e WHERE e.request_id = p_request),
    'init_state', (SELECT to_jsonb(w) - 'updated_at' FROM public.workflow_initialization_state w WHERE w.request_id = p_request)
  )
$$;

CREATE FUNCTION pg_temp.t_assert(p_condition BOOLEAN, p_message TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_message; END IF;
END;
$$;

-- ============================================================
-- 0. Structure, privileges and the trust anchor
-- ============================================================
BEGIN;
DO $$
DECLARE
  table_owner NAME;
  role_name TEXT;
  fn TEXT;
  before_triggers TEXT[];
BEGIN
  SELECT pg_get_userbyid(relowner) INTO table_owner FROM pg_class WHERE oid = 'public.financial_requests'::regclass;
  PERFORM pg_temp.t_assert(table_owner = current_user, format('run this script as the table owner %s, not %s', table_owner, current_user));

  -- The workflow functions must run as the table owner, or trusted
  -- transitions would be rejected (and fail closed).
  FOREACH fn IN ARRAY ARRAY['f16_record_approval_decision', 'f19_amend_request_workflow', 'f16_start_initial_approval_stage'] LOOP
    PERFORM pg_temp.t_assert(
      (SELECT bool_and(prosecdef AND pg_get_userbyid(proowner) = table_owner) FROM pg_proc WHERE proname = fn AND pronamespace = 'public'::regnamespace),
      format('%s must be SECURITY DEFINER and owned by %s', fn, table_owner)
    );
  END LOOP;

  -- No API role can become the owner.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    PERFORM pg_temp.t_assert(NOT pg_has_role(role_name, table_owner, 'MEMBER'), format('%s must not be a member of %s', role_name, table_owner));
  END LOOP;

  -- Guard function: SECURITY INVOKER, no SET ROLE-sensitive config, no API EXECUTE.
  PERFORM pg_temp.t_assert(
    (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = table_owner FROM pg_proc WHERE oid = 'public.f19_guard_request_status()'::regprocedure),
    'f19_guard_request_status must be SECURITY INVOKER and owned by the table owner'
  );
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM pg_temp.t_assert(NOT has_function_privilege(role_name, 'public.f19_guard_request_status()', 'EXECUTE'), format('%s must not execute the guard function', role_name));
  END LOOP;

  -- Amendment grants are unchanged from F19.2.
  fn := 'public.f19_amend_request_workflow(uuid, numeric, public.funding_source, text, text, text, text, jsonb, text)';
  PERFORM pg_temp.t_assert(has_function_privilege('authenticated', fn, 'EXECUTE'), 'authenticated must execute the amendment function');
  PERFORM pg_temp.t_assert(NOT has_function_privilege('anon', fn, 'EXECUTE'), 'anon must not execute the amendment function');
  PERFORM pg_temp.t_assert(
    NOT EXISTS (SELECT 1 FROM pg_proc, aclexplode(proacl) a WHERE oid = fn::regprocedure AND a.grantee = 0),
    'PUBLIC must not execute the amendment function'
  );

  -- The guard fires on every insert and update, after every other BEFORE trigger.
  PERFORM pg_temp.t_assert(
    (SELECT tgenabled = 'O' AND pg_get_triggerdef(oid) = 'CREATE TRIGGER zz_f19_guard_request_status BEFORE INSERT OR UPDATE ON public.financial_requests FOR EACH ROW EXECUTE FUNCTION f19_guard_request_status()'
     FROM pg_trigger WHERE tgrelid = 'public.financial_requests'::regclass AND tgname = 'zz_f19_guard_request_status'),
    'zz_f19_guard_request_status must be an enabled BEFORE INSERT OR UPDATE row trigger'
  );
  SELECT array_agg(tgname::TEXT ORDER BY tgname) INTO before_triggers
  FROM pg_trigger
  WHERE tgrelid = 'public.financial_requests'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2;
  PERFORM pg_temp.t_assert(before_triggers[array_upper(before_triggers, 1)] = 'zz_f19_guard_request_status', format('guard must fire last; BEFORE triggers: %s', before_triggers));

  RAISE NOTICE 'PASS 0: structure, privileges and trust anchor (owner %)', table_owner;
END;
$$;
ROLLBACK;

-- ============================================================
-- 1. current_user inside SECURITY DEFINER workflow functions
-- ============================================================
-- A probe trigger, SECURITY INVOKER like the guard, records current_user for
-- each status-changing or direct update. Created and dropped in this
-- transaction only.
BEGIN;
CREATE FUNCTION public.t_f19_status_guard_probe() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM set_config('f19test.probe', current_setting('f19test.probe', true) || current_user || ';', true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER t_f19_status_guard_probe AFTER UPDATE ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.t_f19_status_guard_probe();
DO $$
DECLARE
  req UUID;
BEGIN
  PERFORM pg_temp.t_setup();
  req := pg_temp.t_request('submitted', 2);
  PERFORM pg_temp.t_start(req);

  -- Decision through the RPC while the session role is authenticated.
  PERFORM set_config('f19test.probe', '', true);
  PERFORM pg_temp.t_decide(req, 'approve');
  PERFORM pg_temp.t_assert(current_setting('f19test.probe') = 'postgres;', format('decision ran as %s', current_setting('f19test.probe')));
  PERFORM pg_temp.t_assert((SELECT status FROM public.financial_requests WHERE id = req) = 'under_review', 'advance to under_review');

  -- Amendment through the RPC while the session role is authenticated.
  PERFORM set_config('f19test.probe', '', true);
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_amend_sql(req));
  PERFORM pg_temp.t_assert(current_setting('f19test.probe') = 'postgres;postgres;', format('amendment ran as %s', current_setting('f19test.probe')));

  -- A direct update by the same authenticated role is seen as authenticated.
  PERFORM set_config('f19test.probe', '', true);
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(), format('UPDATE public.financial_requests SET title = %L WHERE id = %L', 'Probe title', req));
  PERFORM pg_temp.t_assert(current_setting('f19test.probe') = 'authenticated;', format('direct update ran as %s', current_setting('f19test.probe')));

  RAISE NOTICE 'PASS 1: current_user is the owner inside workflow functions and the API role for direct writes';
END;
$$;
ROLLBACK;

-- ============================================================
-- 2. Layer 1: pending requests can still be amended
-- ============================================================
BEGIN;
DO $$
DECLARE
  req_submitted UUID;
  req_review UUID;
  stage_1 UUID;
  stage_2 UUID;
BEGIN
  PERFORM pg_temp.t_setup();

  -- submitted, stage 1 active.
  req_submitted := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_submitted);
  SELECT id INTO stage_1 FROM public.approval_stage_tracking WHERE request_id = req_submitted;
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_amend_sql(req_submitted));
  PERFORM pg_temp.t_assert(
    (SELECT status = 'under_review' AND workflow_revision = 2 AND amount = 2000 FROM public.financial_requests WHERE id = req_submitted),
    'submitted amendment: request is under_review at revision 2 with the new amount'
  );
  PERFORM pg_temp.t_assert(
    (SELECT status = 'cancelled' AND completed_at IS NOT NULL FROM public.approval_stage_tracking WHERE id = stage_1),
    'submitted amendment: the active stage is cancelled'
  );
  PERFORM pg_temp.t_assert(
    EXISTS (SELECT 1 FROM public.approval_stage_tracking WHERE request_id = req_submitted AND workflow_revision = 2 AND stage_order = 1 AND status = 'active' AND queue_id = 'provost_finance'),
    'submitted amendment: revision 2 restarts at stage 1'
  );
  PERFORM pg_temp.t_assert((SELECT COUNT(*) = 1 FROM public.request_workflow_amendments WHERE request_id = req_submitted), 'submitted amendment: one amendment record');

  -- under_review: stage 1 approved, stage 2 active.
  req_review := pg_temp.t_request('submitted', 2);
  PERFORM pg_temp.t_start(req_review);
  SELECT id INTO stage_1 FROM public.approval_stage_tracking WHERE request_id = req_review AND stage_order = 1;
  PERFORM pg_temp.t_decide(req_review, 'approve');
  SELECT id INTO stage_2 FROM public.approval_stage_tracking WHERE request_id = req_review AND stage_order = 2;
  PERFORM pg_temp.t_assert((SELECT status = 'under_review' FROM public.financial_requests WHERE id = req_review), 'advance to under_review');
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(), pg_temp.t_amend_sql(req_review));
  PERFORM pg_temp.t_assert((SELECT status = 'completed' FROM public.approval_stage_tracking WHERE id = stage_1), 'under_review amendment: the completed stage is kept');
  PERFORM pg_temp.t_assert((SELECT status = 'cancelled' FROM public.approval_stage_tracking WHERE id = stage_2), 'under_review amendment: the active stage is cancelled');
  PERFORM pg_temp.t_assert(
    (SELECT status = 'under_review' AND workflow_revision = 2 FROM public.financial_requests WHERE id = req_review),
    'under_review amendment: request is under_review at revision 2'
  );

  -- The new revision can still be decided (R4 uses the current revision).
  PERFORM pg_temp.t_decide(req_review, 'approve');
  PERFORM pg_temp.t_assert((SELECT status = 'approved' FROM public.financial_requests WHERE id = req_review), 'amended request is approved by revision 2');

  RAISE NOTICE 'PASS 2: submitted and under_review requests are amended exactly as before';
END;
$$;
ROLLBACK;

-- ============================================================
-- 3. Layer 1: decided requests cannot be amended
-- ============================================================
BEGIN;
DO $$
DECLARE
  req_approved UUID;
  req_rejected UUID;
  req_completed UUID;
  req UUID;
  snapshot JSONB;
  caller UUID;
BEGIN
  PERFORM pg_temp.t_setup();

  req_approved := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_approved);
  PERFORM pg_temp.t_decide(req_approved, 'approve');

  req_rejected := pg_temp.t_request('submitted', 2);
  PERFORM pg_temp.t_start(req_rejected);
  PERFORM pg_temp.t_decide(req_rejected, 'reject');

  -- No workflow produces completed; the owner inserts it directly. The
  -- request has a stage, so the initialization check would pass.
  req_completed := pg_temp.t_request('completed', 1);
  INSERT INTO public.approval_stage_tracking (request_id, workflow_revision, stage_order, queue_id, stage_name, started_at, duration_hours, deadline_at, status, completed_at)
  VALUES (req_completed, 1, 1, 'department_budget', 'Department Budget Reviewer', now() - interval '2 hour', 72, now() + interval '70 hour', 'completed', now() - interval '1 hour');

  FOREACH req IN ARRAY ARRAY[req_approved, req_rejected, req_completed] LOOP
    FOREACH caller IN ARRAY ARRAY[pg_temp.t_owner(), pg_temp.t_reviewer(), pg_temp.t_admin()] LOOP
      snapshot := pg_temp.t_snapshot(req);
      PERFORM pg_temp.t_expect_error(
        format('amend %s as %s', snapshot #>> '{request,status}', caller),
        'authenticated', caller, pg_temp.t_amend_sql(req),
        'P0001', format('Only requests awaiting a decision can be amended. Current status: %s.', snapshot #>> '{request,status}')
      );
      PERFORM pg_temp.t_assert(pg_temp.t_snapshot(req) = snapshot, format('rejected amendment of %s changed nothing', snapshot #>> '{request,status}'));
    END LOOP;
  END LOOP;

  -- Authorization is still checked first.
  PERFORM pg_temp.t_expect_error('amend approved as unrelated user', 'authenticated', pg_temp.t_other(), pg_temp.t_amend_sql(req_approved), 'P0001', 'Not authorized to amend this request.');

  RAISE NOTICE 'PASS 3: approved, rejected and completed requests cannot be amended, with no side effects';
END;
$$;
ROLLBACK;

-- ============================================================
-- 4. Layer 2: API callers cannot change status
-- ============================================================
BEGIN;
DO $$
DECLARE
  req_approved UUID;
  req_rejected UUID;
  req_completed UUID;
  req_submitted UUID;
  req_review UUID;
  req UUID;
  snapshots JSONB := '{}';
  status_events BIGINT;
  status_update TEXT := 'UPDATE public.financial_requests SET status = %L WHERE id = %L';
BEGIN
  PERFORM pg_temp.t_setup();

  req_approved := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_approved);
  PERFORM pg_temp.t_decide(req_approved, 'approve');
  req_rejected := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_rejected);
  PERFORM pg_temp.t_decide(req_rejected, 'reject');
  req_completed := pg_temp.t_request('completed', 1);
  req_submitted := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_submitted);
  req_review := pg_temp.t_request('submitted', 2);
  PERFORM pg_temp.t_start(req_review);
  PERFORM pg_temp.t_decide(req_review, 'approve');

  FOREACH req IN ARRAY ARRAY[req_approved, req_rejected, req_completed, req_submitted, req_review] LOOP
    snapshots := snapshots || jsonb_build_object(req::TEXT, pg_temp.t_snapshot(req));
  END LOOP;
  SELECT COUNT(*) INTO status_events FROM public.workflow_events WHERE event_type = 'status_changed';

  -- Final decisions cannot be reopened or changed, even by admin or reviewer (R1).
  PERFORM pg_temp.t_expect_error('reviewer approved -> submitted', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'submitted', req_approved), '23514', 'Request status approved is final and cannot change to submitted.');
  PERFORM pg_temp.t_expect_error('reviewer approved -> under_review', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'under_review', req_approved), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('admin approved -> rejected', 'authenticated', pg_temp.t_admin(), format(status_update, 'rejected', req_approved), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('admin approved -> completed', 'authenticated', pg_temp.t_admin(), format(status_update, 'completed', req_approved), '23514', 'Request status approved is final and cannot change to completed.');
  PERFORM pg_temp.t_expect_error('reviewer rejected -> submitted', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'submitted', req_rejected), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('admin rejected -> approved', 'authenticated', pg_temp.t_admin(), format(status_update, 'approved', req_rejected), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('admin completed -> approved', 'authenticated', pg_temp.t_admin(), format(status_update, 'approved', req_completed), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('service_role approved -> submitted', 'service_role', NULL, format(status_update, 'submitted', req_approved), '23514', 'is final');

  -- Pending requests cannot bypass the decision workflow (R2).
  PERFORM pg_temp.t_expect_error('reviewer submitted -> approved', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'approved', req_submitted), '42501', 'Request status can only change through the approval workflow.');
  PERFORM pg_temp.t_expect_error('admin submitted -> rejected', 'authenticated', pg_temp.t_admin(), format(status_update, 'rejected', req_submitted), '42501', 'approval workflow');
  PERFORM pg_temp.t_expect_error('reviewer submitted -> under_review', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'under_review', req_submitted), '42501', 'approval workflow');
  PERFORM pg_temp.t_expect_error('reviewer under_review -> rejected', 'authenticated', pg_temp.t_reviewer(), format(status_update, 'rejected', req_review), '42501', 'approval workflow');
  PERFORM pg_temp.t_expect_error('admin under_review -> submitted', 'authenticated', pg_temp.t_admin(), format(status_update, 'submitted', req_review), '42501', 'approval workflow');
  PERFORM pg_temp.t_expect_error('service_role submitted -> approved', 'service_role', NULL, format(status_update, 'approved', req_submitted), '42501', 'approval workflow');
  -- The owner's own submitted request: RLS and the guard both refuse it.
  PERFORM pg_temp.t_expect_error('owner submitted -> approved', 'authenticated', pg_temp.t_owner(), format(status_update, 'approved', req_submitted), '42501');

  -- The client-settable workflow flags do not grant trust.
  PERFORM pg_temp.t_expect_error(
    'reviewer with trusted-write flags set', 'authenticated', pg_temp.t_reviewer(),
    format(
      'SELECT set_config(%L, %L, true), set_config(%L, %L, true); ' || status_update,
      'app.f19_trusted_workflow_write', 'on', 'app.f19_allow_amendment_write', 'on', 'approved', req_submitted
    ),
    '42501', 'approval workflow'
  );

  FOREACH req IN ARRAY ARRAY[req_approved, req_rejected, req_completed, req_submitted, req_review] LOOP
    PERFORM pg_temp.t_assert(pg_temp.t_snapshot(req) = snapshots -> req::TEXT, format('rejected status writes left %s unchanged', req));
  END LOOP;
  PERFORM pg_temp.t_assert(
    (SELECT COUNT(*) FROM public.workflow_events WHERE event_type = 'status_changed') = status_events,
    'rejected status writes logged no status_changed events'
  );

  -- Updates that keep the status still work.
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(), format('UPDATE public.financial_requests SET title = %L WHERE id = %L', 'Reviewer title edit', req_approved));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(), format('UPDATE public.financial_requests SET status = %L, title = %L WHERE id = %L', 'approved', 'Same-status edit', req_approved));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format('UPDATE public.financial_requests SET description = %L WHERE id = %L', 'Owner edit while submitted', req_submitted));
  PERFORM pg_temp.t_assert((SELECT title = 'Same-status edit' AND status = 'approved' FROM public.financial_requests WHERE id = req_approved), 'same-status update applied');

  RAISE NOTICE 'PASS 4: API callers cannot change status; same-status updates still work';
END;
$$;
ROLLBACK;

-- ============================================================
-- 5. Layer 2: API inserts start as submitted
-- ============================================================
BEGIN;
DO $$
DECLARE
  insert_sql TEXT := $sql$
    INSERT INTO public.financial_requests (user_id, title, requester_email, department, funding_source, amount, needed_by, priority, description%s)
    VALUES (%L, 'F19.2 insert fixture', 'owner@howard.edu', 'Finance', 'department', 100, current_date + 30, 'medium', 'Insert check'%s)
  $sql$;
  status_value TEXT;
BEGIN
  PERFORM pg_temp.t_setup();

  FOREACH status_value IN ARRAY ARRAY['approved', 'rejected', 'under_review', 'completed'] LOOP
    PERFORM pg_temp.t_expect_error(
      format('insert %s', status_value), 'authenticated', pg_temp.t_owner(),
      format(insert_sql, ', status', pg_temp.t_owner(), format(', %L', status_value)),
      '42501', 'New financial requests must start in submitted status.'
    );
  END LOOP;
  PERFORM pg_temp.t_expect_error(
    'service_role insert approved', 'service_role', NULL,
    format(insert_sql, ', status', pg_temp.t_owner(), format(', %L', 'approved')),
    '42501', 'must start in submitted status'
  );

  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(insert_sql, '', pg_temp.t_owner(), ''));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(insert_sql, ', status', pg_temp.t_owner(), format(', %L', 'submitted')));
  PERFORM pg_temp.t_assert(
    (SELECT COUNT(*) = 2 AND bool_and(status = 'submitted') FROM public.financial_requests WHERE user_id = pg_temp.t_owner() AND title = 'F19.2 insert fixture'),
    'default and explicit submitted inserts succeed'
  );

  RAISE NOTICE 'PASS 5: API inserts must start as submitted';
END;
$$;
ROLLBACK;

-- ============================================================
-- 6. Trusted transitions, final statuses (R1), allowlist (R3) and R4
-- ============================================================
BEGIN;
DO $$
DECLARE
  req UUID;
  req_approved UUID;
  req_rejected UUID;
  req_completed UUID;
  status_update TEXT := 'UPDATE public.financial_requests SET status = %L WHERE id = %L';
  insert_stage TEXT := 'INSERT INTO public.approval_stage_tracking (request_id, workflow_revision, stage_order, queue_id, stage_name, started_at, duration_hours, deadline_at, status, completed_at) VALUES (%L, %s, %s, %L, %L, now() - interval ''3 hour'', 72, now() + interval ''69 hour'', %L, %s)';
BEGIN
  PERFORM pg_temp.t_setup();

  -- Legitimate lifecycles through the workflow functions.
  req_approved := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req_approved);
  PERFORM pg_temp.t_decide(req_approved, 'approve');
  PERFORM pg_temp.t_assert((SELECT status = 'approved' FROM public.financial_requests WHERE id = req_approved), 'single-stage approval');

  req_rejected := pg_temp.t_request('submitted', 2);
  PERFORM pg_temp.t_start(req_rejected);
  PERFORM pg_temp.t_decide(req_rejected, 'reject');
  PERFORM pg_temp.t_assert((SELECT status = 'rejected' FROM public.financial_requests WHERE id = req_rejected), 'rejection at stage 1 of 2');

  req := pg_temp.t_request('submitted', 3);
  PERFORM pg_temp.t_start(req);
  PERFORM pg_temp.t_decide(req, 'approve');
  PERFORM pg_temp.t_assert((SELECT status = 'under_review' FROM public.financial_requests WHERE id = req), 'advance 1 -> 2');
  PERFORM pg_temp.t_decide(req, 'approve');
  PERFORM pg_temp.t_assert((SELECT status = 'under_review' FROM public.financial_requests WHERE id = req), 'advance 2 -> 3');
  PERFORM pg_temp.t_decide(req, 'approve');
  PERFORM pg_temp.t_assert(
    (SELECT status = 'approved' FROM public.financial_requests WHERE id = req)
      AND (SELECT COUNT(*) = 3 AND bool_and(status = 'completed') FROM public.approval_stage_tracking WHERE request_id = req),
    'three-stage approval'
  );

  -- A decided request is still not open for another decision.
  PERFORM pg_temp.t_expect_error(
    'decision on approved request', 'authenticated', pg_temp.t_reviewer(),
    format('SELECT public.f16_record_approval_decision(%L, %L, %L, NULL)', req_approved, (SELECT id FROM public.approval_stage_tracking WHERE request_id = req_approved), 'reject'),
    'P0001', 'Request is not open for approval. Current status: approved.'
  );

  -- R1 applies to the owner too, including approved -> completed.
  req_completed := pg_temp.t_request('completed', 1);
  PERFORM pg_temp.t_expect_error('owner approved -> completed', NULL, NULL, format(status_update, 'completed', req_approved), '23514', 'Request status approved is final and cannot change to completed.');
  PERFORM pg_temp.t_expect_error('owner approved -> submitted', NULL, NULL, format(status_update, 'submitted', req_approved), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('owner rejected -> under_review', NULL, NULL, format(status_update, 'under_review', req_rejected), '23514', 'is final');
  PERFORM pg_temp.t_expect_error('owner completed -> approved', NULL, NULL, format(status_update, 'approved', req_completed), '23514', 'is final');

  -- R3: transitions outside the workflow are refused even for the owner.
  req := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_expect_error('owner submitted -> completed', NULL, NULL, format(status_update, 'completed', req), '23514', 'Request status transition submitted -> completed is not permitted.');
  req := pg_temp.t_request('under_review', 1);
  PERFORM pg_temp.t_expect_error('owner under_review -> completed', NULL, NULL, format(status_update, 'completed', req), '23514', 'transition under_review -> completed is not permitted');

  -- R4: decisions need the completed final stage of the current revision.
  req := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_expect_error('owner decides with no stages', NULL, NULL, format(status_update, 'approved', req), '23514', 'final stage of its current workflow revision is completed');

  req := pg_temp.t_request('submitted', 1);
  PERFORM pg_temp.t_start(req);
  PERFORM pg_temp.t_expect_error('owner decides with an active stage', NULL, NULL, format(status_update, 'rejected', req), '23514', 'while an approval stage is still active');

  -- Revision 2's final stage is cancelled; revision 1's completed stage must not count.
  req := pg_temp.t_request('submitted', 1, 2);
  EXECUTE format(insert_stage, req, 1, 1, 'department_budget', 'Department Budget Reviewer', 'completed', 'now() - interval ''2 hour''');
  EXECUTE format(insert_stage, req, 2, 1, 'department_budget', 'Department Budget Reviewer', 'cancelled', 'now() - interval ''1 hour''');
  PERFORM pg_temp.t_expect_error('owner decides on a cancelled final stage', NULL, NULL, format(status_update, 'approved', req), '23514', 'final stage of its current workflow revision is completed');

  -- Only an earlier revision has stages.
  req := pg_temp.t_request('submitted', 1, 2);
  EXECUTE format(insert_stage, req, 1, 1, 'department_budget', 'Department Budget Reviewer', 'completed', 'now() - interval ''2 hour''');
  PERFORM pg_temp.t_expect_error('owner decides with no stage in the current revision', NULL, NULL, format(status_update, 'approved', req), '23514', 'final stage of its current workflow revision is completed');

  -- The highest stage_order decides: stage 2 skipped after a completed stage 1.
  req := pg_temp.t_request('submitted', 2);
  EXECUTE format(insert_stage, req, 1, 1, 'department_budget', 'Department Budget Reviewer', 'completed', 'now() - interval ''2 hour''');
  EXECUTE format(insert_stage, req, 1, 2, 'dean_office', 'Dean''s Office', 'skipped', 'now() - interval ''1 hour''');
  PERFORM pg_temp.t_expect_error('owner decides on a skipped final stage', NULL, NULL, format(status_update, 'approved', req), '23514', 'final stage of its current workflow revision is completed');

  -- R4 is not over-restrictive: a completed final stage in the current revision passes.
  req := pg_temp.t_request('submitted', 1, 2);
  EXECUTE format(insert_stage, req, 1, 1, 'department_budget', 'Department Budget Reviewer', 'cancelled', 'now() - interval ''2 hour''');
  EXECUTE format(insert_stage, req, 2, 1, 'department_budget', 'Department Budget Reviewer', 'completed', 'now() - interval ''1 hour''');
  PERFORM pg_temp.t_exec(NULL, NULL, format(status_update, 'approved', req));
  PERFORM pg_temp.t_assert((SELECT status = 'approved' FROM public.financial_requests WHERE id = req), 'stage-backed owner decision');

  RAISE NOTICE 'PASS 6: workflow transitions work; R1, R3 and R4 hold for the owner';
END;
$$;
ROLLBACK;

\echo 'F19.2 decision status guard: all checks passed.'
