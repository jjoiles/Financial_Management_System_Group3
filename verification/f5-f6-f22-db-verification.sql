-- DB verification for F5.4, F6.4 and F22.4 (issues #281-283, #294-296, #333-335).
-- Runs the "How to Test" SQL steps from the feature docs against a database
-- with all migrations applied. Each check raises an exception on failure.
--
-- Run as a superuser on a disposable database:
--   psql -v ON_ERROR_STOP=1 -f verification/f5-f6-f22-db-verification.sql
-- Do not run against production: it creates and deletes test users.

\set QUIET on
\pset tuples_only on

-- Supabase grants table privileges to these roles by default.
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Test users: A and B are requesters, R is a reviewer.
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'requester.a@howard.edu'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'requester.b@howard.edu'),
  ('cccccccc-0000-0000-0000-000000000003', 'reviewer.r@howard.edu');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'requester'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'requester'),
  ('cccccccc-0000-0000-0000-000000000003', 'reviewer');

-- Acts as a signed-in user, the same way PostgREST does.
CREATE OR REPLACE FUNCTION pg_temp.act_as(uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', uid::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false);
$$;

-- Inserts a request as the current user and returns its id.
CREATE OR REPLACE FUNCTION pg_temp.submit(
  _user uuid, _email text, _funding funding_source, _amount numeric,
  _dept text DEFAULT 'Computer Science', _grant text DEFAULT NULL,
  _pi text DEFAULT NULL, _program text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, grant_number, principal_investigator,
    university_program)
  VALUES (_user, 'Verification request', _email, _dept, _funding, _amount,
    current_date + 30, 'medium', 'Verification request', _grant, _pi, _program)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- ============================================================
\echo '--- F22.4.2 (#334): direct database inserts are rejected'
-- ============================================================
SELECT pg_temp.act_as('aaaaaaaa-0000-0000-0000-000000000001');
SET ROLE authenticated;

DO $$
DECLARE
  cases text[][] := ARRAY[
    ARRAY['gmail email',      'x@gmail.com',        'department', '100',     NULL,     'financial_requests_email_domain'],
    ARRAY['zero amount',      'a@howard.edu',       'department', '0',       NULL,     'financial_requests_amount_range'],
    ARRAY['research no grant','a@howard.edu',       'research',   '100',     NULL,     'financial_requests_research_fields'],
    ARRAY['university no prog','a@howard.edu',      'university', '100',     NULL,     'financial_requests_university_fields']
  ];
  c text[];
  err text;
  hint text;
BEGIN
  FOREACH c SLICE 1 IN ARRAY cases LOOP
    BEGIN
      PERFORM pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', c[2],
        c[3]::funding_source, c[4]::numeric);
      RAISE EXCEPTION 'FAIL: % was accepted', c[1];
    EXCEPTION
      WHEN check_violation OR raise_exception THEN
        GET STACKED DIAGNOSTICS err = MESSAGE_TEXT, hint = PG_EXCEPTION_HINT;
        IF err LIKE 'FAIL:%' THEN RAISE; END IF;
        IF position(c[6] IN coalesce(err,'') || ' ' || coalesce(hint,'')) = 0 THEN
          RAISE EXCEPTION 'FAIL: % rejected, but not by % (got: % / %)', c[1], c[6], err, hint;
        END IF;
        RAISE NOTICE 'PASS: % rejected by %', c[1], c[6];
    END;
  END LOOP;
END $$;

-- Known gap: amount is numeric(12,2), so Postgres rounds 10.555 to 10.56 on
-- input and financial_requests_amount_precision can never fire. The form and
-- payload gateways still reject 3 decimals; a direct insert is rounded, not
-- rejected. This check records that behavior so a fix shows up as a change.
DO $$
DECLARE stored numeric;
BEGIN
  SELECT amount INTO stored FROM public.financial_requests WHERE id = pg_temp.submit(
    'aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 10.555);
  IF stored <> 10.56 THEN RAISE EXCEPTION 'FAIL: expected 10.56, got %', stored; END IF;
  RAISE NOTICE 'FINDING: direct insert of 10.555 is accepted and stored as 10.56 (precision CHECK is unreachable)';
END $$;

-- ============================================================
\echo '--- F22.4.3 (#335): conditional fields are cleared on save'
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  -- Simulates a stale grant number left in a hidden field after switching to Department.
  SELECT * INTO r FROM public.financial_requests WHERE id = pg_temp.submit(
    'aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 250,
    'Computer Science', 'NSF-STALE', 'Dr. Stale', 'Stale Program');
  IF r.grant_number IS NOT NULL OR r.principal_investigator IS NOT NULL
     OR r.university_program IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: conditional fields kept: % / % / %',
      r.grant_number, r.principal_investigator, r.university_program;
  END IF;
  RAISE NOTICE 'PASS: department row saved with grant_number, PI, program = null';
END $$;

-- ============================================================
\echo '--- F5.4.1 (#281): request and attachment events are logged'
-- ============================================================
DO $$
DECLARE rid uuid; n int; att uuid;
BEGIN
  rid := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 500);
  INSERT INTO public.request_attachments (request_id, user_id, file_name, file_path, file_size, content_type)
  VALUES (rid, 'aaaaaaaa-0000-0000-0000-000000000001', 'quote.pdf',
          'aaaaaaaa-0000-0000-0000-000000000001/' || rid || '/quote.pdf', 1234, 'application/pdf')
  RETURNING id INTO att;

  SELECT count(*) INTO n FROM public.workflow_events WHERE request_id = rid AND event_type = 'request_created';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 request_created event, got %', n; END IF;
  SELECT count(*) INTO n FROM public.workflow_events WHERE request_id = rid AND event_type = 'attachment_added';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 attachment_added event, got %', n; END IF;

  DELETE FROM public.request_attachments WHERE id = att;
  SELECT count(*) INTO n FROM public.workflow_events WHERE request_id = rid AND event_type = 'attachment_removed';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 attachment_removed event, got %', n; END IF;

  -- The requester can read their own Activity rows (what the dialog shows).
  SELECT count(*) INTO n FROM public.workflow_events WHERE request_id = rid;
  IF n < 3 THEN RAISE EXCEPTION 'FAIL: requester sees only % events', n; END IF;
  RAISE NOTICE 'PASS: request_created, attachment_added, attachment_removed logged and readable by owner';
  PERFORM set_config('verify.f5_request', rid::text, false);
END $$;

-- ============================================================
\echo '--- F5.4.2 (#282): status and field updates are logged with from/to'
-- ============================================================
RESET ROLE;
SELECT pg_temp.act_as('cccccccc-0000-0000-0000-000000000003');
SET ROLE authenticated;
DO $$
DECLARE rid uuid := current_setting('verify.f5_request')::uuid; e record;
BEGIN
  UPDATE public.financial_requests SET status = 'under_review' WHERE id = rid;
  SELECT * INTO e FROM public.workflow_events
   WHERE request_id = rid AND event_type = 'status_changed' ORDER BY created_at DESC LIMIT 1;
  IF e IS NULL OR e.message <> 'Status changed from submitted to under_review.'
     OR e.metadata->>'from' <> 'submitted' OR e.metadata->>'to' <> 'under_review' THEN
    RAISE EXCEPTION 'FAIL: status event wrong: %', row_to_json(e);
  END IF;
  IF e.actor_user_id <> 'cccccccc-0000-0000-0000-000000000003' THEN
    RAISE EXCEPTION 'FAIL: actor not recorded: %', e.actor_user_id;
  END IF;

  UPDATE public.financial_requests SET amount = 750 WHERE id = rid;
  SELECT * INTO e FROM public.workflow_events
   WHERE request_id = rid AND event_type = 'request_updated' ORDER BY created_at DESC LIMIT 1;
  IF e IS NULL OR e.message NOT LIKE 'Updated %amount%'
     OR (e.metadata->'changes'->'amount'->>'from')::numeric <> 500
     OR (e.metadata->'changes'->'amount'->>'to')::numeric <> 750 THEN
    RAISE EXCEPTION 'FAIL: amount event wrong: %', row_to_json(e);
  END IF;
  RAISE NOTICE 'PASS: "%" and amount from 500 to 750 logged with reviewer as actor',
    'Status changed from submitted to under_review.';
END $$;

-- ============================================================
\echo '--- F6.4.1 (#294): same-grant and possible-duplicate links are created'
-- ============================================================
RESET ROLE;
SELECT pg_temp.act_as('aaaaaaaa-0000-0000-0000-000000000001');
SET ROLE authenticated;
DO $$
DECLARE r1 uuid; r2 uuid; d1 uuid; d2 uuid; n int;
BEGIN
  r1 := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'research', 10000,
                       'Biology', 'NSF-2041', 'Dr. Ada');
  r2 := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'research', 12000,
                       'Biology', 'nsf-2041', 'Dr. Ada');
  SELECT count(*) INTO n FROM public.request_links
   WHERE link_type = 'same_grant'
     AND ((request_id = r1 AND linked_request_id = r2) OR (request_id = r2 AND linked_request_id = r1));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected same_grant links both ways, got %', n; END IF;

  d1 := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 640, 'Chemistry');
  d2 := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 640, 'Chemistry');
  SELECT count(*) INTO n FROM public.request_links
   WHERE link_type = 'possible_duplicate'
     AND ((request_id = d1 AND linked_request_id = d2) OR (request_id = d2 AND linked_request_id = d1));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected possible_duplicate links both ways, got %', n; END IF;

  SELECT count(*) INTO n FROM public.workflow_events WHERE request_id IN (r2, d2) AND event_type = 'record_linked';
  IF n < 2 THEN RAISE EXCEPTION 'FAIL: expected record_linked events, got %', n; END IF;
  RAISE NOTICE 'PASS: NSF-2041 / nsf-2041 linked as same_grant; matching Chemistry requests linked as possible_duplicate; record_linked logged';
END $$;

-- ============================================================
\echo '--- F6.4.2 (#295): users cannot see links to other users'' requests'
-- ============================================================
RESET ROLE;
SELECT pg_temp.act_as('bbbbbbbb-0000-0000-0000-000000000002');
SET ROLE authenticated;
DO $$
DECLARE b1 uuid; n_total int; n_visible int;
BEGIN
  b1 := pg_temp.submit('bbbbbbbb-0000-0000-0000-000000000002', 'b@howard.edu', 'research', 9000,
                       'Biology', 'NSF-2041', 'Dr. Ben');
  SELECT count(*) INTO n_visible FROM public.request_links WHERE request_id = b1 OR linked_request_id = b1;
  SELECT count(*) INTO n_total FROM public.financial_requests WHERE user_id <> 'bbbbbbbb-0000-0000-0000-000000000002';
  IF n_visible <> 0 THEN RAISE EXCEPTION 'FAIL: user B sees % links to user A''s requests', n_visible; END IF;
  IF n_total <> 0 THEN RAISE EXCEPTION 'FAIL: user B can read % of user A''s requests', n_total; END IF;
  PERFORM set_config('verify.b1', b1::text, false);
END $$;
RESET ROLE;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.request_links WHERE request_id = current_setting('verify.b1')::uuid;
  IF n = 0 THEN RAISE EXCEPTION 'FAIL: no cross-user link was created, so the RLS check proved nothing'; END IF;
  RAISE NOTICE 'PASS: % cross-user same_grant links exist, user B sees none of them', n;
END $$;
SELECT pg_temp.act_as('cccccccc-0000-0000-0000-000000000003');
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.request_links WHERE request_id = current_setting('verify.b1')::uuid;
  IF n = 0 THEN RAISE EXCEPTION 'FAIL: reviewer cannot see cross-user links'; END IF;
  RAISE NOTICE 'PASS: reviewer sees % cross-user links', n;
END $$;
RESET ROLE;

-- ============================================================
\echo '--- F6.4.3 (#296): deleting a user with requests is blocked'
-- ============================================================
DO $$
DECLARE err text;
BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FAIL: user with requests was deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS err = CONSTRAINT_NAME;
    IF err <> 'financial_requests_user_id_fkey' THEN
      RAISE EXCEPTION 'FAIL: blocked by % instead of financial_requests_user_id_fkey', err;
    END IF;
    RAISE NOTICE 'PASS: delete blocked by financial_requests_user_id_fkey';
  END;
END $$;

-- F6 step 6: attachment counts. Two attachments on one request.
SELECT pg_temp.act_as('aaaaaaaa-0000-0000-0000-000000000001');
SET ROLE authenticated;
DO $$
DECLARE rid uuid; n int;
BEGIN
  rid := pg_temp.submit('aaaaaaaa-0000-0000-0000-000000000001', 'a@howard.edu', 'department', 333, 'Physics');
  INSERT INTO public.request_attachments (request_id, user_id, file_name, file_path)
  VALUES (rid, 'aaaaaaaa-0000-0000-0000-000000000001', 'a.pdf', 'aaaaaaaa-0000-0000-0000-000000000001/' || rid || '/a.pdf'),
         (rid, 'aaaaaaaa-0000-0000-0000-000000000001', 'b.pdf', 'aaaaaaaa-0000-0000-0000-000000000001/' || rid || '/b.pdf');
  SELECT count(*) INTO n FROM public.request_attachments WHERE request_id = rid;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: owner sees % attachments, expected 2', n; END IF;
  RAISE NOTICE 'PASS: owner reads 2 attachments for the request (source of the My Requests count)';
END $$;
RESET ROLE;

\echo '--- All DB checks passed'
