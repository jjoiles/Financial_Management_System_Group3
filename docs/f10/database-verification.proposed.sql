-- REVIEW ONLY. Do not execute against the shared production database.
-- Future isolated test environment: apply reviewed proposal first, supply
-- existing requester/reviewer/admin UUIDs via psql variables. No accounts or
-- roles are created by this script. All test request changes roll back.
BEGIN;
SELECT set_config('f10.requester', :'requester_id', true);
SELECT set_config('f10.reviewer', :'reviewer_id', true);
SELECT set_config('f10.admin', :'admin_id', true);

DO $$
DECLARE
  fixture_request_id uuid := gen_random_uuid();
  alert_event uuid;
  first_count integer;
  reviewer_id uuid := current_setting('f10.reviewer')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = reviewer_id AND role = 'reviewer') THEN
    RAISE EXCEPTION 'An existing authorized reviewer fixture is required';
  END IF;
  INSERT INTO public.financial_requests
    (id, user_id, title, requester_email, department, funding_source, amount, needed_by, description)
    VALUES (fixture_request_id, current_setting('f10.requester')::uuid, 'F10 isolated verification',
      'verification@howard.edu', 'Verification', 'department', 100, current_date + 7, 'Rollback-only verification');
  SELECT e.id INTO STRICT alert_event FROM public.reviewer_notification_events e WHERE e.request_id = fixture_request_id
    AND e.reason = 'submitted';
  -- Qualified aliases below avoid ambiguous identifier resolution.
  SELECT count(*) INTO first_count FROM public.reviewer_notifications n WHERE n.event_id = alert_event;
  IF first_count < 1 THEN RAISE EXCEPTION 'Expected persisted reviewer delivery'; END IF;
  PERFORM public.f10_deliver_reviewer_event(alert_event);
  IF (SELECT count(*) FROM public.reviewer_notifications n WHERE n.event_id = alert_event) <> first_count THEN
    RAISE EXCEPTION 'Retry duplicated recipients';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications n
    WHERE n.event_id = alert_event AND NOT EXISTS (SELECT 1 FROM public.user_roles u
      WHERE u.user_id = n.recipient_user_id AND u.role IN ('reviewer', 'admin'))) THEN
    RAISE EXCEPTION 'Unauthorized recipient';
  END IF;
END;
$$;

-- Run under real RLS, not the privileged fixture setup role.
SELECT set_config('request.jwt.claim.sub', current_setting('f10.reviewer'), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE alert_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE recipient_user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'Cross-recipient disclosure';
  END IF;
  SELECT id INTO alert_id FROM public.reviewer_notifications LIMIT 1;
  IF alert_id IS NULL THEN RAISE EXCEPTION 'Reviewer fixture has no readable alert'; END IF;
  UPDATE public.reviewer_notifications SET read_at = now() WHERE id = alert_id;
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE id = alert_id AND read_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Read acknowledgement failed';
  END IF;
  UPDATE public.reviewer_notifications SET read_at = NULL WHERE id = alert_id;
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE id = alert_id AND read_at IS NULL) THEN
    RAISE EXCEPTION 'Unread acknowledgement failed';
  END IF;
  IF has_column_privilege(current_user, 'public.reviewer_notifications', 'recipient_user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'Recipient column must not be editable';
  END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('f10.requester'), true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications) THEN RAISE EXCEPTION 'Requester sees reviewer alerts'; END IF;
  IF has_table_privilege(current_user, 'public.reviewer_notifications', 'INSERT') THEN
    RAISE EXCEPTION 'Browser can fabricate reviewer alerts';
  END IF;
END;
$$;
RESET ROLE;
ROLLBACK;