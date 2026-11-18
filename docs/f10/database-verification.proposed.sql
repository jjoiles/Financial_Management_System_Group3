-- REVIEW ONLY / UNEXECUTED. ISOLATED DATABASE ONLY after separate approval.
-- Requires five EXISTING distinct identities via psql variables: requester_id,
-- reviewer_id, second_reviewer_id, admin_id, leadership_id. No accounts created.
-- Isolated fixture setup needs privileged DDL/role-switch rights. Role removals,
-- fixture requests and failure injection below are ONLY for an authorized clone.
-- ROLLBACK restores records/DDL, but identity sequence increments are not undone.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('f10.requester', :'requester_id', true);
SELECT set_config('f10.reviewer', :'reviewer_id', true);
SELECT set_config('f10.second', :'second_reviewer_id', true);
SELECT set_config('f10.admin', :'admin_id', true);
SELECT set_config('f10.leadership', :'leadership_id', true);
SELECT set_config('f10.request', gen_random_uuid()::text, true);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = current_setting('f10.reviewer')::uuid AND role = 'reviewer')
    OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = current_setting('f10.second')::uuid AND role = 'reviewer')
    OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = current_setting('f10.admin')::uuid AND role = 'admin')
    OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = current_setting('f10.leadership')::uuid AND role = 'leadership')
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id IN (current_setting('f10.leadership')::uuid, current_setting('f10.requester')::uuid) AND role IN ('reviewer','admin')) THEN
    RAISE EXCEPTION 'Existing exact-role fixtures are required';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(ARRAY[current_setting('f10.requester'),current_setting('f10.reviewer'),current_setting('f10.second'),current_setting('f10.admin'),current_setting('f10.leadership')]) x) <> 5 THEN
    RAISE EXCEPTION 'Five distinct existing fixtures required';
  END IF;
  INSERT INTO public.financial_requests (id,user_id,title,requester_email,department,funding_source,amount,needed_by,description)
    VALUES (current_setting('f10.request')::uuid,current_setting('f10.requester')::uuid,'F10 isolated test','verification@howard.edu','Verification','department',100,current_date+7,'Rollback-only fixture');
  IF (SELECT count(*) FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid) <> 1 THEN RAISE EXCEPTION 'Submission event count'; END IF;
  IF (SELECT count(*) FROM public.reviewer_notifications WHERE request_id=current_setting('f10.request')::uuid AND recipient_user_id=current_setting('f10.reviewer')::uuid) <> 1 THEN RAISE EXCEPTION 'Reviewer submission alert missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications n WHERE n.request_id=current_setting('f10.request')::uuid AND NOT EXISTS (SELECT 1 FROM public.user_roles u WHERE u.user_id=n.recipient_user_id AND u.role IN ('reviewer','admin'))) THEN RAISE EXCEPTION 'Unauthorized recipient'; END IF;
  IF (SELECT count(*) FROM public.requester_status_notifications WHERE request_id=current_setting('f10.request')::uuid AND new_status='submitted') <> 1 THEN RAISE EXCEPTION 'F11 submission changed'; END IF;
END;
$$;
SELECT set_config('f10.event',(SELECT id::text FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid),true);

-- Actual RLS and column grants, with AAL2 reviewer.
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.reviewer'),'aal','aal2')::text,true);
SELECT set_config('request.jwt.claim.sub',current_setting('f10.reviewer'),true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE alert_id uuid;
BEGIN
  IF NOT public.f10_reviewer_access() THEN RAISE EXCEPTION 'Exact reviewer denied'; END IF;
  SELECT id INTO STRICT alert_id FROM public.reviewer_notifications WHERE event_id=current_setting('f10.event')::uuid;
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE recipient_user_id<>auth.uid()) THEN RAISE EXCEPTION 'Foreign alert visible'; END IF;
  UPDATE public.reviewer_notifications SET read_at=now() WHERE id=alert_id;
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE id=alert_id AND read_at IS NOT NULL) THEN RAISE EXCEPTION 'Mark read failed'; END IF;
  UPDATE public.reviewer_notifications SET read_at=NULL WHERE id=alert_id;
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE id=alert_id AND read_at IS NULL) THEN RAISE EXCEPTION 'Mark unread failed'; END IF;
  IF has_column_privilege(current_user,'public.reviewer_notifications','recipient_user_id','UPDATE') OR has_table_privilege(current_user,'public.reviewer_notifications','INSERT') OR has_table_privilege(current_user,'public.reviewer_notifications','DELETE') THEN RAISE EXCEPTION 'Browser excessive grants'; END IF;
  IF has_function_privilege(current_user,'public.f10_deliver_reviewer_event(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Internal helper executable'; END IF;
  BEGIN
    PERFORM public.f10_retry_reviewer_event(current_setting('f10.event')::uuid);
    RAISE EXCEPTION 'Reviewer retry unexpectedly authorized';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

-- Lower-assurance reviewer cannot read or update even a previously owned alert.
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.reviewer'),'aal','aal1')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE touched integer;
BEGIN
  IF public.f10_reviewer_access() OR EXISTS (SELECT 1 FROM public.reviewer_notifications) THEN RAISE EXCEPTION 'AAL1 read allowed'; END IF;
  UPDATE public.reviewer_notifications SET read_at=now() WHERE event_id=current_setting('f10.event')::uuid;
  GET DIAGNOSTICS touched=ROW_COUNT;
  IF touched<>0 THEN RAISE EXCEPTION 'AAL1 write allowed'; END IF;
END;
$$;
RESET ROLE;

-- Leadership-only and requester-only exact-role rejection, independent of F12 helper.
SELECT set_config('request.jwt.claim.sub',current_setting('f10.leadership'),true);
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.leadership'),'aal','aal2')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF public.f10_reviewer_access() OR EXISTS (SELECT 1 FROM public.reviewer_notifications) THEN RAISE EXCEPTION 'Leadership allowed'; END IF;
  BEGIN PERFORM public.f10_retry_reviewer_event(current_setting('f10.event')::uuid); RAISE EXCEPTION 'Leadership retry allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',current_setting('f10.requester'),true);
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.requester'),'aal','aal2')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF public.f10_reviewer_access() OR EXISTS (SELECT 1 FROM public.reviewer_notifications) THEN RAISE EXCEPTION 'Requester reviewer access'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requester_status_notifications WHERE request_id=current_setting('f10.request')::uuid) THEN RAISE EXCEPTION 'F11 requester read changed'; END IF;
END; $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF has_table_privilege(current_user,'public.reviewer_notifications','SELECT') OR has_function_privilege(current_user,'public.f10_retry_reviewer_event(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous grants'; END IF;
END; $$;
RESET ROLE;

-- Scoped role revocation inside savepoint; never execute in production.
SAVEPOINT revoked_role;
DELETE FROM public.user_roles WHERE user_id=current_setting('f10.reviewer')::uuid AND role IN ('reviewer','admin');
SELECT set_config('request.jwt.claim.sub',current_setting('f10.reviewer'),true);
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.reviewer'),'aal','aal2')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN IF public.f10_reviewer_access() OR EXISTS (SELECT 1 FROM public.reviewer_notifications) THEN RAISE EXCEPTION 'Revoked role access survives'; END IF; END; $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT revoked_role;

-- AAL1 admin cannot read outcomes/retry; AAL2 admin can retry without duplicates.
SELECT set_config('request.jwt.claim.sub',current_setting('f10.admin'),true);
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.admin'),'aal','aal1')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.reviewer_notification_events) THEN RAISE EXCEPTION 'AAL1 admin outcomes'; END IF;
  BEGIN PERFORM public.f10_retry_reviewer_event(current_setting('f10.event')::uuid); RAISE EXCEPTION 'AAL1 admin retry'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.admin'),'aal','aal2')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF public.f10_retry_reviewer_event(current_setting('f10.event')::uuid)<>'delivered' THEN RAISE EXCEPTION 'Admin retry failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notification_events WHERE id=current_setting('f10.event')::uuid) THEN RAISE EXCEPTION 'Admin outcomes denied'; END IF;
END; $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT event_id,recipient_user_id FROM public.reviewer_notifications GROUP BY event_id,recipient_user_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate recipients'; END IF;
  UPDATE public.financial_requests SET status='submitted' WHERE id=current_setting('f10.request')::uuid;
  IF (SELECT count(*) FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid)<>1 THEN RAISE EXCEPTION 'No-op produced event'; END IF;
  UPDATE public.financial_requests SET status='under_review' WHERE id=current_setting('f10.request')::uuid;
  UPDATE public.financial_requests SET status='submitted' WHERE id=current_setting('f10.request')::uuid;
  UPDATE public.financial_requests SET status='under_review' WHERE id=current_setting('f10.request')::uuid;
  IF (SELECT count(*) FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid)<>3 THEN RAISE EXCEPTION 'Repeated genuine review transition lost'; END IF;
  IF (SELECT count(*) FROM public.requester_status_notifications WHERE request_id=current_setting('f10.request')::uuid)<>4 THEN RAISE EXCEPTION 'F11 transition count changed'; END IF;
END; $$;

-- Missing reviewers, older-event retries and inactive outcome. Isolated only.
SAVEPOINT no_reviewers;
DELETE FROM public.user_roles WHERE role IN ('reviewer','admin');
UPDATE public.financial_requests SET status='submitted' WHERE id=current_setting('f10.request')::uuid;
UPDATE public.financial_requests SET status='under_review' WHERE id=current_setting('f10.request')::uuid;
SELECT set_config('f10.old_event',(SELECT id::text FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid ORDER BY event_order DESC LIMIT 1),true);
DO $$ BEGIN
  IF (SELECT outcome FROM public.reviewer_notification_events WHERE id=current_setting('f10.old_event')::uuid)<>'unassigned' THEN RAISE EXCEPTION 'Missing reviewers not safe'; END IF;
  IF EXISTS (SELECT 1 FROM public.reviewer_notifications WHERE event_id=current_setting('f10.old_event')::uuid) THEN RAISE EXCEPTION 'Invented recipient'; END IF;
END; $$;
UPDATE public.financial_requests SET status='submitted' WHERE id=current_setting('f10.request')::uuid;
UPDATE public.financial_requests SET status='under_review' WHERE id=current_setting('f10.request')::uuid;
DO $$ BEGIN
  IF public.f10_deliver_reviewer_event(current_setting('f10.old_event')::uuid)<>'superseded' THEN RAISE EXCEPTION 'Old retry not superseded'; END IF;
END; $$;
UPDATE public.financial_requests SET status='approved' WHERE id=current_setting('f10.request')::uuid;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid AND outcome='unassigned') THEN RAISE EXCEPTION 'Terminal old events active'; END IF;
END; $$;
ROLLBACK TO SAVEPOINT no_reviewers;

-- Failure injection only in authorized isolated clone; F11 must still persist.
SAVEPOINT failed_delivery;
CREATE FUNCTION public.f10_test_reject_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Isolated injected failure'; END; $$;
CREATE TRIGGER f10_test_reject_alert BEFORE INSERT ON public.reviewer_notifications FOR EACH ROW EXECUTE FUNCTION public.f10_test_reject_alert();
UPDATE public.financial_requests SET status='submitted' WHERE id=current_setting('f10.request')::uuid;
UPDATE public.financial_requests SET status='under_review' WHERE id=current_setting('f10.request')::uuid;
SELECT set_config('f10.failed_event',(SELECT id::text FROM public.reviewer_notification_events WHERE request_id=current_setting('f10.request')::uuid ORDER BY event_order DESC LIMIT 1),true);
DO $$ BEGIN
  IF (SELECT outcome FROM public.reviewer_notification_events WHERE id=current_setting('f10.failed_event')::uuid)<>'failed' THEN RAISE EXCEPTION 'Delivery failure not stored'; END IF;
  IF (SELECT status FROM public.financial_requests WHERE id=current_setting('f10.request')::uuid)<>'under_review' THEN RAISE EXCEPTION 'Submission/status blocked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requester_status_notifications WHERE request_id=current_setting('f10.request')::uuid AND new_status='under_review') THEN RAISE EXCEPTION 'F11 failure coexistence'; END IF;
END; $$;
DROP TRIGGER f10_test_reject_alert ON public.reviewer_notifications;
SELECT set_config('request.jwt.claim.sub',current_setting('f10.admin'),true);
SELECT set_config('request.jwt.claims',json_build_object('sub',current_setting('f10.admin'),'aal','aal2')::text,true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN IF public.f10_retry_reviewer_event(current_setting('f10.failed_event')::uuid)<>'delivered' THEN RAISE EXCEPTION 'Failure recovery retry failed'; END IF; END; $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT failed_delivery;
ROLLBACK;
-- Separate two-session concurrency scenario remains required: hold request row
-- lock in session A while session B retries the old event; after A commits a
-- newer review transition B must return superseded, never add old alerts.
