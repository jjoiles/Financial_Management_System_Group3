-- F19.5.5: read-only export of exactly the F19.3 loader columns, as JSON,
-- from the DISPOSABLE database. Run by db/run.sh with -v reviewer=<user id>.
-- The session is the authenticated reviewer (RLS applies, as for the loader)
-- in America/New_York, so timestamps carry -04:00 / -05:00 offsets.

\set ON_ERROR_STOP on
SET default_transaction_read_only = on;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL timezone = 'America/New_York';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'reviewer', true) \g /dev/null
SELECT json_build_object(
  'counts', json_build_object(
    'financial_requests', (SELECT count(*) FROM public.financial_requests),
    'approval_stage_tracking', (SELECT count(*) FROM public.approval_stage_tracking)),
  'financial_requests', (SELECT COALESCE(json_agg(json_build_object(
      'id', r.id, 'status', r.status, 'created_at', r.created_at) ORDER BY r.id), '[]'::JSON)
    FROM public.financial_requests r),
  'approval_stage_tracking', (SELECT COALESCE(json_agg(json_build_object(
      'id', s.id, 'request_id', s.request_id, 'workflow_revision', s.workflow_revision,
      'stage_order', s.stage_order, 'queue_id', s.queue_id, 'status', s.status,
      'started_at', s.started_at, 'completed_at', s.completed_at) ORDER BY s.id), '[]'::JSON)
    FROM public.approval_stage_tracking s));
ROLLBACK;
