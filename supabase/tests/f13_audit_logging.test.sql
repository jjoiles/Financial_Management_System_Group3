BEGIN;

SELECT plan(14);

-- Test users and requests.
INSERT INTO public.user_roles (user_id, role)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'requester'),
  ('22222222-2222-4222-8222-222222222222', 'reviewer');

-- Create the first request as a requester.
SELECT set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

INSERT INTO public.financial_requests (
  id, request_number, user_id, title, requester_email,
  department, funding_source, amount, needed_by,
  priority, description
)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'FR-F13-REQUESTER',
  '11111111-1111-4111-8111-111111111111',
  'Audit test requester request',
  'requester@test.local',
  'Computer Science',
  'department',
  500,
  '2027-01-15',
  'medium',
  'F13 audit logging test request'
);

-- Update the request. The trigger should record both the status
-- change and the changed financial amount.
UPDATE public.financial_requests
SET status = 'under_review',
    amount = 750
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

-- Create a second request as a reviewer.
SELECT set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

INSERT INTO public.financial_requests (
  id, request_number, user_id, title, requester_email,
  department, funding_source, amount, needed_by,
  priority, description
)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'FR-F13-REVIEWER',
  '22222222-2222-4222-8222-222222222222',
  'Audit test reviewer request',
  'reviewer@test.local',
  'Finance',
  'department',
  1200,
  '2027-02-15',
  'medium',
  'F13 reviewer visibility test request'
);

-- 1. Creation event captures its authenticated actor.
SELECT is(
  (
    SELECT actor_user_id
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND event_type = 'request_created'
  ),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'Creation event records the responsible user'
);

-- 2. Actor roles are snapshotted.
SELECT is(
  (
    SELECT metadata -> 'actorRoles'
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND event_type = 'request_created'
  ),
  '["requester"]'::jsonb,
  'Creation event records actor roles'
);

-- 3. Database timestamp is recorded.
SELECT ok(
  (
    SELECT created_at IS NOT NULL
       AND created_at <= statement_timestamp()
       AND created_at >= now() - interval '5 minutes'
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND event_type = 'request_created'
  ),
  'Creation event records a valid database timestamp'
);

-- 4. Status changes are recorded with their actor.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND event_type = 'status_changed'
      AND actor_user_id = '11111111-1111-4111-8111-111111111111'
  ),
  'Status change event records the responsible user'
);

-- 5. Financial field changes are recorded.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND event_type = 'request_updated'
      AND metadata -> 'changes' ? 'amount'
  ),
  'Request update event records changed amount'
);

-- 6–11. Verify database permissions.
SELECT ok(
  has_table_privilege('authenticated', 'public.workflow_events', 'SELECT'),
  'Authenticated users have audit read permission'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_events', 'INSERT'),
  'Authenticated users cannot directly insert audit events'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_events', 'UPDATE'),
  'Authenticated users cannot update historical audit events'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_events', 'DELETE'),
  'Authenticated users cannot delete historical audit events'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_events', 'TRUNCATE'),
  'Authenticated users cannot truncate audit history'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_events', 'SELECT'),
  'Anonymous users cannot read audit events'
);

-- 12–13. Verify requester visibility using actual RLS.
SELECT set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.workflow_events
    WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  3,
  'Requester can see all three events for their own request'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.workflow_events
    WHERE request_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  0,
  'Requester cannot see another users audit history'
);

RESET ROLE;

-- 14. Verify reviewer visibility across requests.
SELECT set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.workflow_events
  ),
  4,
  'Reviewer can see audit history for both requests'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
