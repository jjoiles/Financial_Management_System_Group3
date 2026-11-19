-- Transaction-rolled-back integration tests. Fixture auth.users, user_roles, request and
-- stage rows exist only inside the transaction; the final ROLLBACK removes them all.
-- Requires a privileged CI database connection with UPDATE, ALTER, and SET ROLE rights.
-- The managed sandbox connection cannot run the full script; do not widen its grants.
-- The connection must be the financial_requests table owner: since the F19.2 decision
-- status guard (20261119072711), only the owner (the workflow functions) may change status,
-- only through workflow transitions, and approved/rejected/completed are final. The
-- direct transitions below (submitted <-> under_review) are the ones the workflow itself
-- makes; approvals and rejections go through f16_record_approval_decision.
-- Prerequisites:
--   * the F11 notification table and trigger (drizzle/migrations/0001 and 0002);
--   * the F16 approval workflow objects (approval_stage_tracking, user_roles,
--     f16_start_initial_approval_stage, f16_record_approval_decision);
--   * the F19.2 decision status guard, 20261119072711_f19_2_decision_status_guard.sql.
-- On a database without the guard, the refused-transition assertions fail
-- ("FAIL: guard allowed ..."), because the transitions they expect to be refused succeed.
BEGIN;
DO $$
DECLARE
  test_request_id uuid := gen_random_uuid();
  approval_request_id uuid := gen_random_uuid();
  rejection_request_id uuid := gen_random_uuid();
  owner_id uuid := '11111111-1111-4111-8111-111111111111';
  other_id uuid := '22222222-2222-4222-8222-222222222222';
  reviewer_id uuid := '33333333-3333-4333-8333-333333333333';
  -- Single-step routing, the shape f16_start_initial_approval_stage requires.
  routing jsonb := jsonb_build_object(
    'primaryQueue', 'department_budget', 'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(jsonb_build_object(
      'step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')),
    'flags', jsonb_build_array(), 'rulesVersion', 'f11-decision-alert-fixture');
  stage_id uuid;
  count_before integer;
BEGIN
  -- financial_requests.user_id, user_roles.user_id and workflow_events.actor_user_id
  -- reference auth.users, so the fixture identities must exist (rolled back with the rest).
  INSERT INTO auth.users (id) VALUES (owner_id), (other_id), (reviewer_id) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES (reviewer_id, 'reviewer'::public.app_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  INSERT INTO public.financial_requests (id, user_id, title, requester_email, department,
    funding_source, amount, needed_by, description)
  VALUES (test_request_id, owner_id, 'F11 rollback test', 'f11-test@howard.edu', 'Chemistry',
    'department', 1, current_date + 1, 'Transaction-only verification');
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id AND recipient_user_id = owner_id AND new_status = 'submitted') <> 1 THEN
    RAISE EXCEPTION 'FAIL: submission recipient'; END IF;
  UPDATE public.financial_requests SET status = 'under_review' WHERE id = test_request_id;
  UPDATE public.financial_requests SET status = 'under_review' WHERE id = test_request_id;
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: transition/unchanged/duplicate prevention'; END IF;
  BEGIN
    UPDATE public.financial_requests SET status = 'submitted' WHERE id = test_request_id;
    RAISE EXCEPTION 'intentional request transaction failure';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  IF (SELECT status FROM public.financial_requests WHERE id = test_request_id) <> 'under_review' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: rolled-back updates created notification'; END IF;
  BEGIN
    UPDATE public.financial_requests SET status = 'completed' WHERE id = test_request_id;
    RAISE EXCEPTION 'FAIL: guard allowed under_review -> completed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM public.financial_requests WHERE id = test_request_id) <> 'under_review' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: guard-refused transition created notification'; END IF;
  BEGIN
    ALTER TABLE public.requester_status_notifications ADD CONSTRAINT f11_test_failure
      CHECK (new_status <> 'submitted') NOT VALID;
    UPDATE public.financial_requests SET status = 'submitted' WHERE id = test_request_id;
    IF (SELECT status FROM public.financial_requests WHERE id = test_request_id) <> 'submitted' OR
      (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
      RAISE EXCEPTION 'FAIL: notification failure corrupted status'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0011', MESSAGE = 'roll back failure injection';
  EXCEPTION WHEN SQLSTATE 'P0011' THEN NULL;
  END;
  -- Decision alerts through the approval workflow, the application path for decisions
  -- under the F19.2 guard. The reviewer decides as an authenticated API caller; the
  -- SECURITY DEFINER function makes the status change as the table owner.
  INSERT INTO public.financial_requests (id, user_id, title, requester_email, department,
    funding_source, amount, needed_by, description, routed_to, metadata)
  VALUES (approval_request_id, owner_id, 'F11 approval alert test', 'f11-test@howard.edu', 'Chemistry',
    'department', 1, current_date + 1, 'Transaction-only verification',
    routing ->> 'primaryLabel', jsonb_build_object('routing', routing));
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  SET LOCAL ROLE authenticated;
  stage_id := public.f16_start_initial_approval_stage(approval_request_id);
  RESET ROLE;
  IF stage_id IS NULL OR (SELECT status FROM public.financial_requests WHERE id = approval_request_id) <> 'submitted' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = approval_request_id) <> 1 THEN
    RAISE EXCEPTION 'FAIL: starting the approval stage changed status or alerts'; END IF;
  PERFORM set_config('request.jwt.claim.sub', reviewer_id::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.f16_record_approval_decision(approval_request_id, stage_id, 'approve', NULL);
  RESET ROLE;
  IF (SELECT status FROM public.financial_requests WHERE id = approval_request_id) <> 'approved' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = approval_request_id) <> 2 OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = approval_request_id
      AND n.recipient_user_id = owner_id AND n.new_status = 'approved' AND n.previous_status = 'submitted') <> 1 THEN
    RAISE EXCEPTION 'FAIL: approval alert'; END IF;
  -- approved is final for every caller, including the table owner running this suite.
  BEGIN
    UPDATE public.financial_requests SET status = 'completed' WHERE id = approval_request_id;
    RAISE EXCEPTION 'FAIL: guard allowed approved -> completed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM public.financial_requests WHERE id = approval_request_id) <> 'approved' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = approval_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: refused final-status change created notification'; END IF;
  INSERT INTO public.financial_requests (id, user_id, title, requester_email, department,
    funding_source, amount, needed_by, description, routed_to, metadata)
  VALUES (rejection_request_id, owner_id, 'F11 rejection alert test', 'f11-test@howard.edu', 'Chemistry',
    'department', 1, current_date + 1, 'Transaction-only verification',
    routing ->> 'primaryLabel', jsonb_build_object('routing', routing));
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  SET LOCAL ROLE authenticated;
  stage_id := public.f16_start_initial_approval_stage(rejection_request_id);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', reviewer_id::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.f16_record_approval_decision(rejection_request_id, stage_id, 'reject', NULL);
  RESET ROLE;
  IF (SELECT status FROM public.financial_requests WHERE id = rejection_request_id) <> 'rejected' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = rejection_request_id) <> 2 OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = rejection_request_id
      AND n.recipient_user_id = owner_id AND n.new_status = 'rejected' AND n.previous_status = 'submitted') <> 1 THEN
    RAISE EXCEPTION 'FAIL: rejection alert'; END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF has_table_privilege('authenticated', 'public.requester_status_notifications', 'INSERT') OR
    has_column_privilege('authenticated', 'public.requester_status_notifications', 'new_status', 'UPDATE') OR
    has_table_privilege('anon', 'public.requester_status_notifications', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: unauthorized grants'; END IF;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 0 THEN
    RAISE EXCEPTION 'FAIL: another user read alert'; END IF;
  UPDATE public.requester_status_notifications SET read_at = now() WHERE requester_status_notifications.request_id = test_request_id;
  GET DIAGNOSTICS count_before = ROW_COUNT;
  IF count_before <> 0 THEN RAISE EXCEPTION 'FAIL: another user acknowledged alert'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: owner cannot read'; END IF;
  UPDATE public.requester_status_notifications SET read_at = now() WHERE requester_status_notifications.request_id = test_request_id;
  GET DIAGNOSTICS count_before = ROW_COUNT;
  IF count_before <> 2 THEN RAISE EXCEPTION 'FAIL: owner cannot acknowledge'; END IF;
  RESET ROLE;
  RAISE NOTICE 'F11 integration assertions passed';
END $$;
ROLLBACK;