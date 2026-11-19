-- F19.5.4.1 security hardening regression checks
-- (supabase/migrations/20261119120100_f19_5_4_1_security_hardening.sql).
--
-- DISPOSABLE DATABASE ONLY. Run through the runner, which starts a throwaway
-- container, applies every migration, seeds pre-hardening history and then
-- runs this script with -v disposable=1:
--   bash verification/f19_5_4_1_disposable_db.sh <supabase-postgres-image>
--
-- Every test section runs in its own transaction and ends with ROLLBACK.
-- Helpers are session-scoped temporary functions. The connection must be the
-- table owner (postgres) and a member of anon, authenticated and service_role.
-- Expected history (seeded by the runner before the migration): two requests
-- titled 'F19.5.4.1 historical fixture' with fixed created_at values.
-- The runner applies every later migration first, so the privilege
-- expectations describe the final schema (F19.5.4.2 also removes the default
-- DELETE privilege of authenticated).

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

CREATE FUNCTION pg_temp.t_owner() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954100-0000-4000-8000-000000000001'::UUID $$;
CREATE FUNCTION pg_temp.t_other() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954100-0000-4000-8000-000000000002'::UUID $$;
CREATE FUNCTION pg_temp.t_reviewer() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954100-0000-4000-8000-000000000003'::UUID $$;
CREATE FUNCTION pg_temp.t_admin() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954100-0000-4000-8000-000000000004'::UUID $$;
CREATE FUNCTION pg_temp.t_leader() RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT 'f1954100-0000-4000-8000-000000000005'::UUID $$;

CREATE FUNCTION pg_temp.t_setup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id)
  VALUES (pg_temp.t_owner()), (pg_temp.t_other()), (pg_temp.t_reviewer()), (pg_temp.t_admin()), (pg_temp.t_leader())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES
    (pg_temp.t_reviewer(), 'reviewer'::public.app_role),
    (pg_temp.t_admin(), 'admin'::public.app_role),
    (pg_temp.t_leader(), 'leadership'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
END;
$$;

-- Routing with a one- or two-step chain (department budget, then dean's office).
CREATE FUNCTION pg_temp.t_routing(p_steps INTEGER DEFAULT 1) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'primaryQueue', 'department_budget', 'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', CASE WHEN p_steps = 1
      THEN jsonb_build_array(jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer'))
      ELSE jsonb_build_array(jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer'),
                             jsonb_build_object('step', 2, 'queue', 'dean_office', 'label', 'Dean''s Office')) END,
    'flags', jsonb_build_array(), 'rulesVersion', 'f19-5-4-1-fixture')
$$;

-- SQL inserting a request owned by t_owner(), optionally supplying created_at.
CREATE FUNCTION pg_temp.t_insert_sql(p_title TEXT, p_created_at TEXT DEFAULT NULL, p_status TEXT DEFAULT 'submitted', p_steps INTEGER DEFAULT 1) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'INSERT INTO public.financial_requests (user_id, title, requester_email, department, funding_source, amount, needed_by, priority, description, status, routed_to, metadata%s)
     VALUES (%L, %L, %L, %L, %L, 1000, current_date + 30, %L, %L, %L::public.request_status, %L, %L::JSONB%s)',
    CASE WHEN p_created_at IS NULL THEN '' ELSE ', created_at' END,
    pg_temp.t_owner(), p_title, 'owner@howard.edu', 'Finance', 'department', 'medium',
    'F19.5.4.1 fixture', p_status, 'Department Budget Reviewer',
    jsonb_build_object('routing', pg_temp.t_routing(p_steps))::TEXT,
    CASE WHEN p_created_at IS NULL THEN '' ELSE format(', %L::TIMESTAMPTZ', p_created_at) END)
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

-- Requires p_sql to affect exactly p_rows rows.
CREATE FUNCTION pg_temp.t_expect_rows(p_label TEXT, p_role TEXT, p_sub UUID, p_sql TEXT, p_rows INTEGER) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER := pg_temp.t_exec(p_role, p_sub, p_sql);
BEGIN
  IF n <> p_rows THEN
    RAISE EXCEPTION 'FAIL [%]: expected % row(s), got %.', p_label, p_rows, n;
  END IF;
END;
$$;

-- Requires p_sql to fail with p_state (NULL = any error) and, when given, a
-- message containing p_fragment. Everything is rolled back with the subtransaction.
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
    RAISE EXCEPTION 'FAIL [%]: expected an error (%), but the statement succeeded.', p_label, COALESCE(p_state, 'any');
  END IF;
  IF (p_state IS NOT NULL AND got_state <> p_state)
     OR (p_fragment IS NOT NULL AND position(p_fragment IN got_message) = 0) THEN
    RAISE EXCEPTION 'FAIL [%]: expected % "%", got % "%".', p_label, p_state, p_fragment, got_state, got_message;
  END IF;
END;
$$;

-- Starts stage 1 as the owner, then records a decision as the reviewer (the RPC paths the app uses).
CREATE FUNCTION pg_temp.t_start(p_request UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(),
    format('SELECT public.f16_start_initial_approval_stage(%L)', p_request));
END;
$$;

CREATE FUNCTION pg_temp.t_decide(p_request UUID, p_decision TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  stage_id UUID;
BEGIN
  SELECT id INTO STRICT stage_id FROM public.approval_stage_tracking WHERE request_id = p_request AND status = 'active';
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_reviewer(),
    format('SELECT public.f16_record_approval_decision(%L, %L, %L, NULL)', p_request, stage_id, p_decision));
END;
$$;

CREATE FUNCTION pg_temp.t_fiscal_year(p_at TIMESTAMPTZ) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT 'FY' || (EXTRACT(YEAR FROM p_at AT TIME ZONE 'UTC')::INT
                  + CASE WHEN EXTRACT(MONTH FROM p_at AT TIME ZONE 'UTC') >= 7 THEN 1 ELSE 0 END)
$$;

-- ------------------------------------------------------------
-- 1. Triggers and functions are installed in the required order
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  before_insert TEXT[];
  before_update TEXT[];
BEGIN
  -- tgtype bits: 2 = BEFORE, 4 = INSERT, 16 = UPDATE.
  SELECT array_agg(tgname ORDER BY tgname) INTO before_insert FROM pg_trigger
  WHERE tgrelid = 'public.financial_requests'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 AND tgtype & 4 = 4;
  SELECT array_agg(tgname ORDER BY tgname) INTO before_update FROM pg_trigger
  WHERE tgrelid = 'public.financial_requests'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 AND tgtype & 16 = 16;

  IF before_insert[1] <> 'f19_assign_request_created_at' THEN
    RAISE EXCEPTION 'FAIL: f19_assign_request_created_at must be the first BEFORE INSERT trigger, got %', before_insert;
  END IF;
  IF before_insert[array_length(before_insert, 1) - 1:] <> ARRAY['zz_f19_guard_request_created_at', 'zz_f19_guard_request_status']
     OR before_update[array_length(before_update, 1) - 1:] <> ARRAY['zz_f19_guard_request_created_at', 'zz_f19_guard_request_status'] THEN
    RAISE EXCEPTION 'FAIL: the created_at guard must run after every modifying trigger. INSERT %, UPDATE %', before_insert, before_update;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.financial_requests'::regclass AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'FAIL: a financial_requests trigger is disabled.';
  END IF;
  IF has_function_privilege('anon', 'public.f19_assign_request_created_at()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.f19_assign_request_created_at()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.f19_guard_request_created_at()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.f19_guard_request_created_at()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: created_at trigger functions must not be executable by API roles.';
  END IF;
  RAISE NOTICE 'PASS 1: trigger order and function privileges';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 2. Privilege matrix and default privileges
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  mismatches TEXT;
BEGIN
  WITH expected(tbl, role, privs) AS (VALUES
    ('financial_requests', 'anon', 'SELECT'),
    ('financial_requests', 'authenticated', 'INSERT,SELECT,UPDATE'),
    ('financial_requests', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('approval_stage_tracking', 'anon', 'SELECT'),
    ('approval_stage_tracking', 'authenticated', 'SELECT'),
    ('approval_stage_tracking', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('workflow_events', 'anon', 'SELECT'),
    ('workflow_events', 'authenticated', 'INSERT,SELECT'),
    ('workflow_events', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('request_workflow_amendments', 'anon', 'SELECT'),
    ('request_workflow_amendments', 'authenticated', 'SELECT'),
    ('request_workflow_amendments', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('workflow_initialization_state', 'anon', 'SELECT'),
    ('workflow_initialization_state', 'authenticated', 'SELECT'),
    ('workflow_initialization_state', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
  ),
  actual AS (
    SELECT e.tbl, e.role, e.privs AS expected,
      COALESCE(string_agg(p, ',' ORDER BY p) FILTER (WHERE has_table_privilege(e.role, 'public.' || e.tbl, p)), '') AS actual
    FROM expected e
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
    GROUP BY e.tbl, e.role, e.privs
  )
  SELECT string_agg(format('%s/%s expected {%s} got {%s}', tbl, role, expected, actual), '; ')
  INTO mismatches FROM actual WHERE expected <> actual;
  IF mismatches IS NOT NULL THEN RAISE EXCEPTION 'FAIL: table privileges: %', mismatches; END IF;

  WITH expected(owner_role, grantee, privs) AS (VALUES
    ('postgres', 'anon', 'SELECT'),
    -- DELETE is removed by the later F19.5.4.2 migration; the runner checks the final schema.
    ('postgres', 'authenticated', 'INSERT,SELECT,UPDATE'),
    ('postgres', 'postgres', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
    ('postgres', 'service_role', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
  ),
  actual AS (
    SELECT pg_get_userbyid(d.defaclrole) AS owner_role, pg_get_userbyid(a.grantee) AS grantee,
           string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'r' AND d.defaclnamespace = 'public'::regnamespace AND pg_get_userbyid(d.defaclrole) = 'postgres'
    GROUP BY 1, 2
  )
  SELECT string_agg(format('%s->%s expected {%s} got {%s}', COALESCE(e.owner_role, a.owner_role), COALESCE(e.grantee, a.grantee), e.privs, a.privs), '; ')
  INTO mismatches
  FROM expected e FULL JOIN actual a ON a.owner_role = e.owner_role AND a.grantee = e.grantee
  WHERE e.privs IS DISTINCT FROM a.privs;
  IF mismatches IS NOT NULL THEN RAISE EXCEPTION 'FAIL: default privileges: %', mismatches; END IF;
  RAISE NOTICE 'PASS 2: table privileges and postgres/public default privileges';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 3. anon and authenticated cannot perform the revoked operations
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  t TEXT;
  key_col TEXT;
  f19_tables TEXT[] := ARRAY['financial_requests', 'approval_stage_tracking', 'workflow_events',
                             'request_workflow_amendments', 'workflow_initialization_state'];
BEGIN
  PERFORM pg_temp.t_setup();
  FOREACH t IN ARRAY f19_tables LOOP
    key_col := CASE t WHEN 'workflow_initialization_state' THEN 'request_id' ELSE 'id' END;
    PERFORM pg_temp.t_expect_error('anon INSERT ' || t, 'anon', NULL, format('INSERT INTO public.%I DEFAULT VALUES', t), '42501');
    PERFORM pg_temp.t_expect_error('anon UPDATE ' || t, 'anon', NULL, format('UPDATE public.%I SET %I = %I WHERE false', t, key_col, key_col), '42501');
    PERFORM pg_temp.t_expect_error('anon DELETE ' || t, 'anon', NULL, format('DELETE FROM public.%I WHERE false', t), '42501');
    PERFORM pg_temp.t_expect_error('anon TRUNCATE ' || t, 'anon', NULL, format('TRUNCATE public.%I', t), '42501');
    PERFORM pg_temp.t_expect_error('authenticated TRUNCATE ' || t, 'authenticated', pg_temp.t_admin(), format('TRUNCATE public.%I', t), '42501');
    PERFORM pg_temp.t_expect_error('authenticated CREATE TRIGGER ' || t, 'authenticated', pg_temp.t_admin(),
      format('CREATE TRIGGER f19_5_4_1_probe BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t), '42501');
    PERFORM pg_temp.t_expect_error('anon CREATE TRIGGER ' || t, 'anon', NULL,
      format('CREATE TRIGGER f19_5_4_1_probe BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t), '42501');
  END LOOP;
  PERFORM pg_temp.t_expect_error('authenticated TRUNCATE CASCADE', 'authenticated', pg_temp.t_admin(), 'TRUNCATE public.financial_requests CASCADE', '42501');
  PERFORM pg_temp.t_expect_error('authenticated DELETE request', 'authenticated', pg_temp.t_admin(), 'DELETE FROM public.financial_requests WHERE false', '42501');
  PERFORM pg_temp.t_expect_error('authenticated UPDATE event', 'authenticated', pg_temp.t_admin(), 'UPDATE public.workflow_events SET message = message WHERE false', '42501');
  PERFORM pg_temp.t_expect_error('authenticated DELETE event', 'authenticated', pg_temp.t_admin(), 'DELETE FROM public.workflow_events WHERE false', '42501');
  PERFORM pg_temp.t_expect_error('authenticated LOCK stages', 'authenticated', pg_temp.t_admin(), 'LOCK TABLE public.approval_stage_tracking IN ACCESS EXCLUSIVE MODE', '42501');
  PERFORM pg_temp.t_expect_error('anon LOCK requests', 'anon', NULL, 'LOCK TABLE public.financial_requests IN ACCESS EXCLUSIVE MODE', '42501');
  RAISE NOTICE 'PASS 3: revoked writes, TRUNCATE, TRIGGER and LOCK are denied';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 4. A client cannot supply the initial created_at (any role)
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  supplied TEXT;
  i INTEGER := 0;
  r RECORD;
  label TEXT;
BEGIN
  PERFORM pg_temp.t_setup();
  FOREACH supplied IN ARRAY ARRAY['2001-02-03T04:05:06Z', '2099-12-31T23:59:59Z', 'infinity', '-infinity',
                                  '10000-01-01T00:00:00Z', '4713-01-01 00:00:00+00 BC', NULL] LOOP
    FOR r IN SELECT * FROM (VALUES ('authenticated', pg_temp.t_owner()), ('service_role', NULL::UUID), (NULL, NULL::UUID)) AS x(role, sub) LOOP
      i := i + 1;
      label := format('insert %s as %s', COALESCE(supplied, '(omitted)'), COALESCE(r.role, 'table owner'));
      PERFORM pg_temp.t_expect_rows(label, r.role, r.sub,
        pg_temp.t_insert_sql('F19.5.4.1 insert ' || i, supplied), 1);
      IF (SELECT created_at FROM public.financial_requests WHERE title = 'F19.5.4.1 insert ' || i) IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'FAIL [%]: created_at was not assigned by the database.', label;
      END IF;
      -- F4 derives request_number and the fiscal period from the authoritative value.
      IF (SELECT metadata #>> '{derived,fiscalYear}' FROM public.financial_requests WHERE title = 'F19.5.4.1 insert ' || i)
           IS DISTINCT FROM pg_temp.t_fiscal_year(now())
         OR (SELECT request_number NOT LIKE 'FR-' || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-%'
             FROM public.financial_requests WHERE title = 'F19.5.4.1 insert ' || i) THEN
        RAISE EXCEPTION 'FAIL [%]: F4 metadata was not derived from the database timestamp.', label;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS 4: % inserts; every supplied created_at was replaced by now()', i;
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 5. created_at cannot change after insertion (every role, every status)
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  req RECORD;
  who RECORD;
  before_values JSONB;
  after_values JSONB;
  shift_sql TEXT;
  checks INTEGER := 0;
BEGIN
  PERFORM pg_temp.t_setup();
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.1 submitted'));
  -- under_review: stage 1 of a two-step chain approved, stage 2 active.
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.1 under_review', NULL, 'submitted', 2));
  PERFORM pg_temp.t_start(pg_temp.t_id('F19.5.4.1 under_review'));
  PERFORM pg_temp.t_decide(pg_temp.t_id('F19.5.4.1 under_review'), 'approve');
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.1 approved'));
  PERFORM pg_temp.t_start(pg_temp.t_id('F19.5.4.1 approved'));
  PERFORM pg_temp.t_decide(pg_temp.t_id('F19.5.4.1 approved'), 'approve');
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.1 rejected'));
  PERFORM pg_temp.t_start(pg_temp.t_id('F19.5.4.1 rejected'));
  PERFORM pg_temp.t_decide(pg_temp.t_id('F19.5.4.1 rejected'), 'reject');
  -- No workflow sets 'completed'; a trusted owner insert is the only way to create one.
  PERFORM pg_temp.t_exec(NULL, NULL, pg_temp.t_insert_sql('F19.5.4.1 completed', NULL, 'completed'));

  SELECT jsonb_object_agg(id, created_at) INTO before_values FROM public.financial_requests WHERE title IN ('F19.5.4.1 submitted', 'F19.5.4.1 under_review', 'F19.5.4.1 approved', 'F19.5.4.1 rejected', 'F19.5.4.1 completed');

  FOR req IN SELECT id, status::TEXT AS status, title FROM public.financial_requests WHERE title IN ('F19.5.4.1 submitted', 'F19.5.4.1 under_review', 'F19.5.4.1 approved', 'F19.5.4.1 rejected', 'F19.5.4.1 completed') ORDER BY title LOOP
    IF req.title <> 'F19.5.4.1 ' || req.status THEN
      RAISE EXCEPTION 'FAIL: fixture % has status %', req.title, req.status;
    END IF;
    FOR who IN SELECT * FROM (VALUES
        ('requester (owner)', 'authenticated', pg_temp.t_owner()),
        ('requester (not owner)', 'authenticated', pg_temp.t_other()),
        ('reviewer', 'authenticated', pg_temp.t_reviewer()),
        ('admin', 'authenticated', pg_temp.t_admin()),
        ('leadership', 'authenticated', pg_temp.t_leader()),
        ('service_role', 'service_role', NULL::UUID),
        ('table owner', NULL, NULL::UUID)) AS x(label, role, sub) LOOP
      checks := checks + 1;
      shift_sql := format('UPDATE public.financial_requests SET created_at = created_at - interval ''30 days'' WHERE id = %L', req.id);
      IF who.label = 'requester (not owner)' OR (who.label = 'requester (owner)' AND req.status <> 'submitted') THEN
        -- RLS hides the row from this user: nothing can change.
        PERFORM pg_temp.t_expect_rows(format('%s on %s', who.label, req.status), who.role, who.sub, shift_sql, 0);
      ELSE
        PERFORM pg_temp.t_expect_error(format('%s on %s', who.label, req.status), who.role, who.sub, shift_sql, '23514', 'created_at cannot be changed');
      END IF;
    END LOOP;
  END LOOP;

  -- Other forms: an explicit literal, infinity (F4 or the guard rejects it), and an upsert.
  PERFORM pg_temp.t_expect_error('reviewer literal', 'authenticated', pg_temp.t_reviewer(),
    format('UPDATE public.financial_requests SET created_at = %L WHERE id = %L', '2001-01-01T00:00:00Z', pg_temp.t_id('F19.5.4.1 approved')), '23514');
  PERFORM pg_temp.t_expect_error('admin infinity', 'authenticated', pg_temp.t_admin(),
    format('UPDATE public.financial_requests SET created_at = %L WHERE id = %L', 'infinity', pg_temp.t_id('F19.5.4.1 rejected')), NULL);
  PERFORM pg_temp.t_expect_error('owner upsert', NULL, NULL,
    format('INSERT INTO public.financial_requests SELECT * FROM public.financial_requests WHERE id = %L
            ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at - interval ''1 day''', pg_temp.t_id('F19.5.4.1 submitted')), '23514');

  -- Updates that leave created_at alone still work.
  PERFORM pg_temp.t_expect_rows('owner edits title while submitted', 'authenticated', pg_temp.t_owner(),
    format('UPDATE public.financial_requests SET description = %L WHERE id = %L', 'edited', pg_temp.t_id('F19.5.4.1 submitted')), 1);
  PERFORM pg_temp.t_expect_rows('reviewer same-value created_at', 'authenticated', pg_temp.t_reviewer(),
    format('UPDATE public.financial_requests SET created_at = created_at, description = description WHERE id = %L', pg_temp.t_id('F19.5.4.1 approved')), 1);

  SELECT jsonb_object_agg(id, created_at) INTO after_values FROM public.financial_requests WHERE title IN ('F19.5.4.1 submitted', 'F19.5.4.1 under_review', 'F19.5.4.1 approved', 'F19.5.4.1 rejected', 'F19.5.4.1 completed');
  IF after_values <> before_values THEN
    RAISE EXCEPTION 'FAIL: created_at changed: before %, after %', before_values, after_values;
  END IF;
  RAISE NOTICE 'PASS 5: % role/status update attempts; created_at unchanged on all 5 statuses', checks;
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 6. Legitimate application operations still work
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  req UUID;
  events_before INTEGER;
  claim_status TEXT;
BEGIN
  PERFORM pg_temp.t_setup();
  -- Submission (browser-submission.ts / request-submission.ts) and reading it back.
  PERFORM pg_temp.t_expect_rows('owner inserts request', 'authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.1 app flow'), 1);
  req := pg_temp.t_id('F19.5.4.1 app flow');
  PERFORM pg_temp.t_expect_rows('owner reads own request', 'authenticated', pg_temp.t_owner(),
    format('SELECT 1 FROM public.financial_requests WHERE id = %L', req), 1);
  PERFORM pg_temp.t_expect_rows('other requester cannot read it', 'authenticated', pg_temp.t_other(),
    format('SELECT 1 FROM public.financial_requests WHERE id = %L', req), 0);
  -- Routing write before initialization (initialize-workflow.ts).
  PERFORM pg_temp.t_expect_rows('owner saves routing', 'authenticated', pg_temp.t_owner(),
    format('UPDATE public.financial_requests SET routed_to = %L, metadata = metadata || jsonb_build_object(''routing'', %L::JSONB) WHERE id = %L',
           'Department Budget Reviewer', pg_temp.t_routing()::TEXT, req), 1);
  -- Workflow initialization claim RPC (initialize-workflow.ts).
  PERFORM pg_temp.t_expect_rows('owner claims workflow initialization', 'authenticated', pg_temp.t_owner(),
    format('SELECT public.f19_claim_workflow_initialization(%L, 120)', req), 1);
  SELECT status INTO claim_status FROM public.workflow_initialization_state WHERE request_id = req;
  IF claim_status IS DISTINCT FROM 'claimed' THEN RAISE EXCEPTION 'FAIL: workflow claim not recorded (%)', claim_status; END IF;
  -- Stage start, then a reviewer decision through the RPC.
  PERFORM pg_temp.t_start(req);
  SELECT count(*) INTO events_before FROM public.workflow_events WHERE request_id = req;
  PERFORM pg_temp.t_decide(req, 'approve');
  IF (SELECT status FROM public.financial_requests WHERE id = req) <> 'approved'
     OR (SELECT count(*) FROM public.workflow_events WHERE request_id = req) <= events_before THEN
    RAISE EXCEPTION 'FAIL: decision RPC did not record the decision and its events';
  END IF;
  -- Event inserts allowed by the existing policies.
  PERFORM pg_temp.t_expect_rows('owner appends own event', 'authenticated', pg_temp.t_owner(),
    format('INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message) VALUES (%L, %L, %L, %L)',
           req, pg_temp.t_owner(), 'note', 'owner note'), 1);
  PERFORM pg_temp.t_expect_rows('reviewer appends event', 'authenticated', pg_temp.t_reviewer(),
    format('INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message) VALUES (%L, %L, %L, %L)',
           req, pg_temp.t_reviewer(), 'note', 'reviewer note'), 1);
  -- Reads.
  PERFORM pg_temp.t_expect_rows('reviewer reads stages', 'authenticated', pg_temp.t_reviewer(),
    format('SELECT 1 FROM public.approval_stage_tracking WHERE request_id = %L', req), 1);
  PERFORM pg_temp.t_expect_rows('owner reads own events', 'authenticated', pg_temp.t_owner(),
    format('SELECT 1 FROM public.workflow_events WHERE request_id = %L AND event_type = %L', req, 'note'), 2);
  -- Amendment of a pending request (f19_amend_request_workflow).
  PERFORM pg_temp.t_expect_rows('owner inserts request to amend', 'authenticated', pg_temp.t_owner(), pg_temp.t_insert_sql('F19.5.4.1 amend'), 1);
  PERFORM pg_temp.t_start(pg_temp.t_id('F19.5.4.1 amend'));
  PERFORM pg_temp.t_exec('authenticated', pg_temp.t_owner(), format(
    'SELECT public.f19_amend_request_workflow(%L, 2000, %L, NULL, NULL, NULL, %L, %L::JSONB, %L)',
    pg_temp.t_id('F19.5.4.1 amend'), 'department', 'Department Budget Reviewer', pg_temp.t_routing()::TEXT, 'hardening regression'));
  IF (SELECT workflow_revision FROM public.financial_requests WHERE id = pg_temp.t_id('F19.5.4.1 amend')) <> 2 THEN
    RAISE EXCEPTION 'FAIL: amendment did not create revision 2';
  END IF;
  RAISE NOTICE 'PASS 6: submission, routing, claim, stage start, decision, events, reads and amendment work';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 7. Pre-hardening timestamps are preserved
-- ------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  hist RECORD;
BEGIN
  IF (SELECT jsonb_agg(created_at ORDER BY created_at) FROM public.financial_requests WHERE title = 'F19.5.4.1 historical fixture')
     IS DISTINCT FROM '["2025-03-04T05:06:07.123456+00:00", "2026-10-31T23:59:59.999999+00:00"]'::JSONB THEN
    RAISE EXCEPTION 'FAIL: historical fixture timestamps changed or are missing: %',
      (SELECT jsonb_agg(created_at ORDER BY created_at) FROM public.financial_requests WHERE title = 'F19.5.4.1 historical fixture');
  END IF;
  -- An ordinary later update keeps the historical value and its derived fiscal period.
  FOR hist IN SELECT id, created_at FROM public.financial_requests WHERE title = 'F19.5.4.1 historical fixture' LOOP
    UPDATE public.financial_requests SET description = 'touched after hardening' WHERE id = hist.id;
    IF (SELECT created_at FROM public.financial_requests WHERE id = hist.id) <> hist.created_at
       OR (SELECT metadata #>> '{derived,fiscalYear}' FROM public.financial_requests WHERE id = hist.id) <> pg_temp.t_fiscal_year(hist.created_at) THEN
      RAISE EXCEPTION 'FAIL: historical request % lost its timestamp or fiscal period', hist.id;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS 7: historical created_at values preserved, including after later updates';
END;
$$;
ROLLBACK;

-- ------------------------------------------------------------
-- 8. Future tables created by postgres in public do not inherit the grants
-- ------------------------------------------------------------

BEGIN;
CREATE TABLE public.f19_5_4_1_future_probe (id INTEGER PRIMARY KEY);
DO $$
DECLARE
  got TEXT;
  r TEXT;
  expected TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    SELECT COALESCE(string_agg(p, ',' ORDER BY p) FILTER (WHERE has_table_privilege(r, 'public.f19_5_4_1_future_probe', p)), '')
    INTO got FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p;
    expected := CASE r
      WHEN 'anon' THEN 'SELECT'
      WHEN 'authenticated' THEN 'INSERT,SELECT,UPDATE'  -- DELETE removed by F19.5.4.2
      ELSE 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' END;
    IF got <> expected THEN
      RAISE EXCEPTION 'FAIL: future table privileges for %: expected {%} got {%}', r, expected, got;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS 8: a new postgres-owned public table gets SELECT (anon), SELECT/INSERT/UPDATE (authenticated) only';
END;
$$;
ROLLBACK;

\echo 'F19.5.4.1 security hardening checks passed.'
