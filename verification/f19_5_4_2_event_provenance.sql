-- F19.5.4.2 workflow event provenance and default DELETE regression checks
-- (supabase/migrations/20261119130000_f19_5_4_2_event_provenance.sql).
--
-- DISPOSABLE DATABASE ONLY. Run through the runner, which applies every
-- migration, seeds pre-migration history and runs this script with
-- -v disposable=1:
--   bash verification/f19_5_4_1_disposable_db.sh <supabase-postgres-image>
--
-- Every test section runs in its own transaction and ends with ROLLBACK.
-- The connection must be the table owner (postgres) and a member of anon,
-- authenticated and service_role.
-- Expected history (seeded by the runner before the migrations): one request
-- titled 'F19.5.4.1 historical fixture' carries a client-inserted event with
-- event_type 'note' and "source": "db_trigger", which the old policies
-- allowed.

\set ON_ERROR_STOP on
SET timezone = 'UTC';

\if :{?disposable}
\else
  \echo 'Refusing to run: this script is for the disposable database only (use verification/f19_5_4_1_disposable_db.sh).'
  \quit
\endif

-- ------------------------------------------------------------
-- Session helpers (temporary; dropped when the session ends)
-- ------------------------------------------------------------

CREATE FUNCTION pg_temp.t_owner() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954200-0000-4000-8000-000000000001'::UUID $$;
CREATE FUNCTION pg_temp.t_other() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954200-0000-4000-8000-000000000002'::UUID $$;
CREATE FUNCTION pg_temp.t_reviewer() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954200-0000-4000-8000-000000000003'::UUID $$;
CREATE FUNCTION pg_temp.t_admin() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954200-0000-4000-8000-000000000004'::UUID $$;

CREATE FUNCTION pg_temp.t_setup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id)
  VALUES (pg_temp.t_owner()), (pg_temp.t_other()), (pg_temp.t_reviewer()), (pg_temp.t_admin())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES
    (pg_temp.t_reviewer(), 'reviewer'::public.app_role),
    (pg_temp.t_admin(), 'admin'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
END;
$$;

CREATE FUNCTION pg_temp.t_routing() RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'primaryQueue', 'department_budget', 'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')),
    'flags', jsonb_build_array(), 'rulesVersion', 'f19-5-4-2-fixture')
$$;

CREATE FUNCTION pg_temp.t_insert_sql(p_title TEXT, p_amount NUMERIC DEFAULT 1000) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'INSERT INTO public.financial_requests (user_id, title, requester_email, department, funding_source, amount, needed_by, priority, description, status, routed_to, metadata)
     VALUES (%L, %L, %L, %L, %L, %s, current_date + 30, %L, %L, %L, %L, %L::JSONB)',
    pg_temp.t_owner(), p_title, 'owner@howard.edu', 'Finance', 'department', p_amount, 'medium',
    'F19.5.4.2 fixture', 'submitted', 'Department Budget Reviewer',
    jsonb_build_object('routing', pg_temp.t_routing())::TEXT)
$$;

CREATE FUNCTION pg_temp.t_id(p_title TEXT) RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id FROM public.financial_requests WHERE title = p_title
$$;

-- Runs p_sql as p_role (NULL = the owner session) with auth.uid() = p_sub; returns ROW_COUNT.
CREATE FUNCTION pg_temp.t_exec(p_role TEXT, p_sub UUID, p_sql TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_sub::TEXT, ''), true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', COALESCE(p_role, 'postgres'))::TEXT, true);
  IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN n;
END;
$$;

CREATE FUNCTION pg_temp.t_expect_rows(p_label TEXT, p_role TEXT, p_sub UUID, p_sql TEXT, p_rows INTEGER) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER := pg_temp.t_exec(p_role, p_sub, p_sql);
BEGIN
  IF n <> p_rows THEN RAISE EXCEPTION 'FAIL [%]: expected % row(s), got %.', p_label, p_rows, n; END IF;
END;
$$;

-- Requires p_sql to fail with p_state and, when given, a message containing p_fragment.
CREATE FUNCTION pg_temp.t_expect_error(
  p_label TEXT, p_role TEXT, p_sub UUID, p_sql TEXT, p_state TEXT, p_fragment TEXT DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  succeeded BOOLEAN := FALSE;
  got_state TEXT;
  got_message TEXT;
BEGIN
  BEGIN
    PERFORM pg_temp.t_exec(p_role, p_sub, p_sql);
    succeeded := TRUE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_message = MESSAGE_TEXT;
  END;
  RESET ROLE;
  IF succeeded THEN
    RAISE EXCEPTION 'FAIL [%]: expected % but the statement succeeded.', p_label, p_state;
  END IF;
  IF got_state <> p_state OR (p_fragment IS NOT NULL AND position(p_fragment IN got_message) = 0) THEN
    RAISE EXCEPTION 'FAIL [%]: expected % "%", got % "%".', p_label, p_state, p_fragment, got_state, got_message;
  END IF;
END;
$$;

-- SQL inserting a client event.
CREATE FUNCTION pg_temp.t_event_sql(p_request UUID, p_type TEXT, p_metadata JSONB DEFAULT '{}', p_actor UUID DEFAULT NULL, p_created_at TEXT DEFAULT NULL)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'INSERT INTO public.workflow_events (request_id, event_type, message, metadata%s%s) VALUES (%L, %L, %L, %L::JSONB%s%s)',
    CASE WHEN p_actor IS NULL THEN '' ELSE ', actor_user_id' END,
    CASE WHEN p_created_at IS NULL THEN '' ELSE ', created_at' END,
    p_request, p_type, 'F19.5.4.2 probe', p_metadata::TEXT,
    CASE WHEN p_actor IS NULL THEN '' ELSE format(', %L::UUID', p_actor) END,
    CASE WHEN p_created_at IS NULL THEN '' ELSE format(', %L::TIMESTAMPTZ', p_created_at) END)
$$;

CREATE FUNCTION pg_temp.t_assert(p_ok BOOLEAN, p_label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
END;
$$;

-- The latest event of p_type for p_request.
CREATE FUNCTION pg_temp.t_event(p_request UUID, p_type TEXT) RETURNS public.workflow_events LANGUAGE sql STABLE AS $$
  SELECT * FROM public.workflow_events WHERE request_id = p_request AND event_type = p_type ORDER BY created_at DESC, id DESC LIMIT 1
$$;

-- ------------------------------------------------------------
-- 1. Structure, privileges and default privileges
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  got TEXT;
  r TEXT;
  expected TEXT;
BEGIN
  PERFORM pg_temp.t_assert(EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.workflow_events'::regclass AND tgname = 'f19_guard_workflow_event_provenance'
      AND tgenabled = 'O' AND tgtype & 2 = 2 AND tgtype & 4 = 4), 'provenance trigger is an enabled BEFORE INSERT trigger');
  PERFORM pg_temp.t_assert((SELECT NOT prosecdef FROM pg_proc WHERE proname = 'f19_guard_workflow_event_provenance'),
    'provenance function is SECURITY INVOKER, so current_user is the caller');
  PERFORM pg_temp.t_assert(NOT has_function_privilege('authenticated', 'public.f19_guard_workflow_event_provenance()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.f19_guard_workflow_event_provenance()', 'EXECUTE'),
    'provenance function is not executable by API roles');

  -- Default privileges: authenticated no longer receives DELETE on future tables.
  SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) INTO got
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclobjtype = 'r' AND d.defaclnamespace = 'public'::regnamespace
    AND pg_get_userbyid(d.defaclrole) = 'postgres' AND pg_get_userbyid(a.grantee) = 'authenticated';
  PERFORM pg_temp.t_assert(got = 'INSERT,SELECT,UPDATE', format('postgres/public default for authenticated is {%s}', got));

  -- Existing application permissions are kept.
  PERFORM pg_temp.t_assert(has_table_privilege('authenticated', 'public.request_attachments', 'DELETE'),
    'existing request_attachments DELETE grant (attachment removal policy) is kept');
  PERFORM pg_temp.t_assert(has_table_privilege('authenticated', 'public.workflow_events', 'INSERT')
    AND has_table_privilege('authenticated', 'public.financial_requests', 'INSERT')
    AND has_table_privilege('authenticated', 'public.financial_requests', 'UPDATE'),
    'existing authenticated INSERT/UPDATE grants are kept');

  -- A future table created by postgres in public.
  CREATE TABLE public.f19_5_4_2_future_probe (id INTEGER PRIMARY KEY);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    SELECT COALESCE(string_agg(p, ',' ORDER BY p) FILTER (WHERE has_table_privilege(r, 'public.f19_5_4_2_future_probe', p)), '')
    INTO got FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p;
    expected := CASE r
      WHEN 'anon' THEN 'SELECT'
      WHEN 'authenticated' THEN 'INSERT,SELECT,UPDATE'
      ELSE 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' END;
    PERFORM pg_temp.t_assert(got = expected, format('future table privileges for %s: expected {%s} got {%s}', r, expected, got));
  END LOOP;
  RAISE NOTICE 'PASS 1: provenance trigger installed; future tables do not grant DELETE to authenticated; existing grants kept';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 2. Clients cannot impersonate database-generated events
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  req UUID;
  reserved TEXT;
  who RECORD;
  src TEXT;
  attempts INTEGER := 0;
  events_before INTEGER;
BEGIN
  PERFORM pg_temp.t_setup();
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.2 target'));
  req := pg_temp.t_id('F19.5.4.2 target');
  SELECT count(*) INTO events_before FROM public.workflow_events WHERE request_id = req;

  FOR who IN SELECT * FROM (VALUES
      ('requester (owner)', 'authenticated', pg_temp.t_owner()),
      ('reviewer', 'authenticated', pg_temp.t_reviewer()),
      ('admin', 'authenticated', pg_temp.t_admin()),
      ('service_role', 'service_role', NULL::UUID)) AS x(label, role, sub) LOOP
    -- Reserved event types, even with an honest source.
    FOREACH reserved IN ARRAY ARRAY['request_created', 'status_changed', 'routing_changed', 'request_updated',
        'attachment_added', 'attachment_removed', 'record_linked', 'approval_approved', 'approval_rejected',
        'workflow_initialized', 'workflow_failed', 'request_amended'] LOOP
      attempts := attempts + 1;
      PERFORM pg_temp.t_expect_error(format('%s inserts %s', who.label, reserved), who.role, who.sub,
        pg_temp.t_event_sql(req, reserved), '42501', 'reserved for database-generated events');
    END LOOP;
    -- Database sources on an ordinary event type.
    FOREACH src IN ARRAY ARRAY['db_trigger', 'f19_workflow_initialization', 'f19_amend_request_workflow', 'DB_TRIGGER', ''] LOOP
      attempts := attempts + 1;
      PERFORM pg_temp.t_expect_error(format('%s claims source "%s"', who.label, src), who.role, who.sub,
        pg_temp.t_event_sql(req, 'note', jsonb_build_object('source', src)), '42501', 'reserved for database-generated events');
    END LOOP;
    attempts := attempts + 1;
    PERFORM pg_temp.t_expect_error(format('%s uses non-object metadata', who.label), who.role, who.sub,
      pg_temp.t_event_sql(req, 'note', '["source", "db_trigger"]'::JSONB), '23514', 'must be a JSON object');
  END LOOP;

  -- Forged actor attribution.
  PERFORM pg_temp.t_expect_error('reviewer attributes an event to the requester', 'authenticated', pg_temp.t_reviewer(),
    pg_temp.t_event_sql(req, 'note', '{}', pg_temp.t_owner()), '42501', 'signed-in user');
  PERFORM pg_temp.t_expect_error('requester attributes an event to the reviewer', 'authenticated', pg_temp.t_owner(),
    pg_temp.t_event_sql(req, 'note', '{}', pg_temp.t_reviewer()), '42501', 'signed-in user');
  PERFORM pg_temp.t_expect_error('service_role attributes an event to a user', 'service_role', NULL,
    pg_temp.t_event_sql(req, 'note', '{}', pg_temp.t_reviewer()), '42501', 'signed-in user');
  -- anon has no INSERT grant at all.
  PERFORM pg_temp.t_expect_error('anon inserts an event', 'anon', NULL, pg_temp.t_event_sql(req, 'note'), '42501');
  -- RLS still applies: another requester cannot append to this request.
  PERFORM pg_temp.t_expect_error('other requester appends to a foreign request', 'authenticated', pg_temp.t_other(),
    pg_temp.t_event_sql(req, 'note'), '42501');

  PERFORM pg_temp.t_assert((SELECT count(*) FROM public.workflow_events WHERE request_id = req) = events_before,
    'no rejected attempt left an event behind');
  RAISE NOTICE 'PASS 2: % impersonation attempts rejected (reserved types, sources, non-object metadata, forged actors)', attempts + 5;
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 3. Legitimate client events are kept and marked as client events
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  req UUID;
  ev public.workflow_events;
BEGIN
  PERFORM pg_temp.t_setup();
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.2 client events'));
  req := pg_temp.t_id('F19.5.4.2 client events');

  -- Owner, no actor, no source, backdated created_at: actor and time come from the database.
  PERFORM pg_temp.t_expect_rows('owner appends a note', 'authenticated', pg_temp.t_owner(),
    pg_temp.t_event_sql(req, 'owner_note', '{"detail": "kept"}', NULL, '2001-01-01T00:00:00Z'), 1);
  ev := pg_temp.t_event(req, 'owner_note');
  PERFORM pg_temp.t_assert(ev.actor_user_id = pg_temp.t_owner(), 'owner note actor is the signed-in owner');
  PERFORM pg_temp.t_assert(ev.created_at = now(), 'client created_at is replaced by now()');
  PERFORM pg_temp.t_assert(ev.metadata = '{"detail": "kept", "source": "client"}'::JSONB, 'client metadata kept and marked source client');

  -- Owner naming itself and source client explicitly.
  PERFORM pg_temp.t_expect_rows('owner appends with explicit actor and source', 'authenticated', pg_temp.t_owner(),
    pg_temp.t_event_sql(req, 'owner_explicit', '{"source": "client"}', pg_temp.t_owner()), 1);
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'owner_explicit')).actor_user_id = pg_temp.t_owner(), 'explicit self-attribution accepted');

  -- Reviewer and admin on someone else's request (existing reviewer policy).
  PERFORM pg_temp.t_expect_rows('reviewer appends a note', 'authenticated', pg_temp.t_reviewer(), pg_temp.t_event_sql(req, 'review_note'), 1);
  ev := pg_temp.t_event(req, 'review_note');
  PERFORM pg_temp.t_assert(ev.actor_user_id = pg_temp.t_reviewer() AND ev.metadata ->> 'source' = 'client', 'reviewer note attributed to the reviewer, source client');
  PERFORM pg_temp.t_expect_rows('admin appends a note', 'authenticated', pg_temp.t_admin(), pg_temp.t_event_sql(req, 'admin_note'), 1);

  -- service_role: no signed-in user, so no actor.
  PERFORM pg_temp.t_expect_rows('service_role appends a note', 'service_role', NULL, pg_temp.t_event_sql(req, 'service_note'), 1);
  ev := pg_temp.t_event(req, 'service_note');
  PERFORM pg_temp.t_assert(ev.actor_user_id IS NULL AND ev.metadata ->> 'source' = 'client', 'service_role note has no actor and source client');

  -- The owner can read them back.
  PERFORM pg_temp.t_expect_rows('owner reads client events', 'authenticated', pg_temp.t_owner(),
    format('SELECT 1 FROM public.workflow_events WHERE request_id = %L AND metadata ->> %L = %L', req, 'source', 'client'), 5);
  RAISE NOTICE 'PASS 3: requester, reviewer, admin and service_role client events accepted with trusted actor, time and source';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 4. Database-generated events from every path are unchanged
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  req UUID;
  amend UUID;
  dup UUID;
  stage_id UUID;
  claim JSONB;
  ev public.workflow_events;
BEGIN
  PERFORM pg_temp.t_setup();

  -- f5: request_created, then routing_changed and request_updated on owner updates.
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.2 db events'));
  req := pg_temp.t_id('F19.5.4.2 db events');
  ev := pg_temp.t_event(req, 'request_created');
  PERFORM pg_temp.t_assert(ev.metadata ->> 'source' = 'db_trigger' AND ev.actor_user_id = pg_temp.t_owner(), 'f5 request_created');
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(
    'UPDATE public.financial_requests SET routed_to = %L, description = %L WHERE id = %L', 'Dean''s Office', 'edited', req));
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'routing_changed')).metadata ->> 'source' = 'db_trigger', 'f5 routing_changed');
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'request_updated')).metadata ->> 'source' = 'db_trigger', 'f5 request_updated');
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(
    'UPDATE public.financial_requests SET routed_to = %L WHERE id = %L', 'Department Budget Reviewer', req));

  -- f5: attachment_added and attachment_removed.
  PERFORM pg_temp.t_expect_rows('owner attaches a file', 'authenticated', pg_temp.t_owner(), format(
    'INSERT INTO public.request_attachments (request_id, user_id, file_name, file_path) VALUES (%L, %L, %L, %L)',
    req, pg_temp.t_owner(), 'quote.pdf', req || '/quote.pdf'), 1);
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'attachment_added')).metadata ->> 'source' = 'db_trigger', 'f5 attachment_added');
  PERFORM pg_temp.t_expect_rows('owner removes the file', 'authenticated', pg_temp.t_owner(), format(
    'DELETE FROM public.request_attachments WHERE request_id = %L', req), 1);
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'attachment_removed')).actor_user_id = pg_temp.t_owner(), 'f5 attachment_removed');

  -- f6: record_linked (same requester, department, funding source and amount).
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.2 duplicate'));
  dup := pg_temp.t_id('F19.5.4.2 duplicate');
  PERFORM pg_temp.t_assert(EXISTS (SELECT 1 FROM public.workflow_events WHERE event_type = 'record_linked'
    AND request_id IN (req, dup) AND actor_user_id IS NULL AND metadata ->> 'source' = 'db_trigger'), 'f6 record_linked');

  -- f19: workflow claim and completion, with a client attempt to smuggle a source.
  PERFORM set_config('request.jwt.claim.sub', pg_temp.t_owner()::TEXT, true);
  SET LOCAL ROLE authenticated;
  claim := public.f19_claim_workflow_initialization(req, 120);
  PERFORM public.f19_complete_workflow_initialization(req, (claim ->> 'claimToken')::UUID, 'simulated', 1,
    NULL, '{"source": "db_trigger", "extra": "client-supplied"}'::JSONB);
  RESET ROLE;
  ev := pg_temp.t_event(req, 'workflow_initialized');
  PERFORM pg_temp.t_assert(ev.metadata ->> 'source' = 'f19_workflow_initialization' AND ev.actor_user_id = pg_temp.t_owner(),
    format('f19 workflow_initialized (RPC overrides a client-supplied source): %s', ev.metadata));

  -- f16: approval decision through the RPC, as the reviewer.
  SELECT id INTO STRICT stage_id FROM public.approval_stage_tracking WHERE request_id = req AND status = 'active';
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(),
    format('SELECT public.f16_record_approval_decision(%L, %L, %L, NULL)', req, stage_id, 'approve'));
  ev := pg_temp.t_event(req, 'approval_approved');
  PERFORM pg_temp.t_assert(ev.actor_user_id = pg_temp.t_reviewer() AND ev.metadata ->> 'decision' = 'approve', 'f16 approval_approved');
  PERFORM pg_temp.t_assert((pg_temp.t_event(req, 'status_changed')).metadata ->> 'to' = 'approved', 'f5 status_changed on decision');

  -- f19: amendment of a pending request.
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.2 amend', 1500));
  amend := pg_temp.t_id('F19.5.4.2 amend');
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format('SELECT public.f16_start_initial_approval_stage(%L)', amend));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(
    'SELECT public.f19_amend_request_workflow(%L, 2000, %L, NULL, NULL, NULL, %L, %L::JSONB, %L)',
    amend, 'department', 'Department Budget Reviewer', pg_temp.t_routing()::TEXT, 'provenance regression'));
  ev := pg_temp.t_event(amend, 'request_amended');
  PERFORM pg_temp.t_assert(ev.metadata ->> 'source' = 'f19_amend_request_workflow' AND ev.actor_user_id = pg_temp.t_owner(), 'f19 request_amended');

  -- f16: rejection on a second request.
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.2 reject', 1700));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format('SELECT public.f16_start_initial_approval_stage(%L)', pg_temp.t_id('F19.5.4.2 reject')));
  SELECT id INTO STRICT stage_id FROM public.approval_stage_tracking WHERE request_id = pg_temp.t_id('F19.5.4.2 reject') AND status = 'active';
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(),
    format('SELECT public.f16_record_approval_decision(%L, %L, %L, NULL)', pg_temp.t_id('F19.5.4.2 reject'), stage_id, 'reject'));
  PERFORM pg_temp.t_assert((pg_temp.t_event(pg_temp.t_id('F19.5.4.2 reject'), 'approval_rejected')).actor_user_id = pg_temp.t_reviewer(), 'f16 approval_rejected');

  -- f19: a failed workflow initialization on the duplicate request.
  PERFORM set_config('request.jwt.claim.sub', pg_temp.t_owner()::TEXT, true);
  SET LOCAL ROLE authenticated;
  claim := public.f19_claim_workflow_initialization(dup, 120);
  PERFORM public.f19_complete_workflow_initialization(dup, (claim ->> 'claimToken')::UUID, 'failed', 1, 'definite 400', '{}'::JSONB);
  RESET ROLE;
  ev := pg_temp.t_event(dup, 'workflow_failed');
  PERFORM pg_temp.t_assert(ev.metadata ->> 'source' = 'f19_workflow_initialization' AND ev.actor_user_id = pg_temp.t_owner(), 'f19 workflow_failed');

  -- No database-generated event was marked as a client event.
  PERFORM pg_temp.t_assert(NOT EXISTS (SELECT 1 FROM public.workflow_events
    WHERE request_id IN (req, dup, amend, pg_temp.t_id('F19.5.4.2 reject')) AND metadata ->> 'source' = 'client'),
    'database-generated events are never marked source client');
  RAISE NOTICE 'PASS 4: f5, f6, f16 and f19 events (all 12 reserved types exercised) written unchanged';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 5. Events stored before the migration are not modified
-- ------------------------------------------------------------

BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.t_assert((SELECT count(*) FROM public.workflow_events e JOIN public.financial_requests r ON r.id = e.request_id
    WHERE r.title = 'F19.5.4.1 historical fixture' AND e.event_type = 'note' AND e.metadata ->> 'source' = 'db_trigger') = 1,
    'the pre-migration forged event is still stored exactly as written');
  RAISE NOTICE 'PASS 5: pre-migration events unchanged (a forged historical event stays indistinguishable, as documented)';
END;
$$;
ROLLBACK;

\echo 'F19.5.4.2 event provenance checks passed.'
