-- Transaction-rolled-back integration tests. No auth accounts or permanent rows are created.
-- Requires a privileged CI database connection with UPDATE, ALTER, and SET ROLE rights.
-- The managed sandbox connection cannot run the full script; do not widen its grants.
BEGIN;
DO $$
DECLARE
  test_request_id uuid := gen_random_uuid();
  owner_id uuid := '11111111-1111-4111-8111-111111111111';
  other_id uuid := '22222222-2222-4222-8222-222222222222';
  count_before integer;
BEGIN
  INSERT INTO public.financial_requests (id, user_id, title, requester_email, department,
    funding_source, amount, needed_by, description)
  VALUES (test_request_id, owner_id, 'F11 rollback test', 'f11-test@howard.edu', 'Chemistry',
    'department', 1, current_date + 1, 'Transaction-only verification');
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id AND recipient_user_id = owner_id AND new_status = 'submitted') <> 1 THEN
    RAISE EXCEPTION 'FAIL: submission recipient'; END IF;
  UPDATE public.financial_requests SET status = 'approved' WHERE id = test_request_id;
  UPDATE public.financial_requests SET status = 'approved' WHERE id = test_request_id;
  IF (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: transition/unchanged/duplicate prevention'; END IF;
  BEGIN
    UPDATE public.financial_requests SET status = 'rejected' WHERE id = test_request_id;
    RAISE EXCEPTION 'intentional request transaction failure';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  IF (SELECT status FROM public.financial_requests WHERE id = test_request_id) <> 'approved' OR
    (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
    RAISE EXCEPTION 'FAIL: rolled-back updates created notification'; END IF;
  BEGIN
    ALTER TABLE public.requester_status_notifications ADD CONSTRAINT f11_test_failure
      CHECK (new_status <> 'completed') NOT VALID;
    UPDATE public.financial_requests SET status = 'completed' WHERE id = test_request_id;
    IF (SELECT status FROM public.financial_requests WHERE id = test_request_id) <> 'completed' OR
      (SELECT count(*) FROM public.requester_status_notifications n WHERE n.request_id = test_request_id) <> 2 THEN
      RAISE EXCEPTION 'FAIL: notification failure corrupted status'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0011', MESSAGE = 'roll back failure injection';
  EXCEPTION WHEN SQLSTATE 'P0011' THEN NULL;
  END;
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