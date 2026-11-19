-- F19.5.5: seed one synthetic scenario into the DISPOSABLE database.
-- Run by db/run.sh as the bootstrap superuser with -v data=<scenario JSON>
-- and -v owner=<fixture user id>. Never run against the local stack.
--
-- The scenarios represent historical data (fixed created_at values, a decided
-- request that still has an active stage, a request with status completed).
-- The current triggers would rewrite or refuse those rows, so they are written
-- the way the controlled correction process in docs/F19_Security_Hardening.md
-- allows: with triggers bypassed for this transaction only
-- (session_replication_role = replica). CHECK, UNIQUE and NOT NULL
-- constraints still apply, which is why some scenarios are TypeScript-only.

\set ON_ERROR_STOP on

-- Safety guard. This script empties public.financial_requests. It runs only
-- when db/run.sh passes -v disposable=1 for its throwaway container: an
-- unset variable, or any value other than exactly 1, stops here with an
-- error before any statement below.
\if :{?disposable}
  SELECT :'disposable' = '1' AS f19_5_5_disposable \gset
\else
  \set f19_5_5_disposable false
\endif
\if :f19_5_5_disposable
\else
  \echo 'Refusing to run: seed.sql empties financial_requests and is for the disposable database only. Run it through verification/f19_5_5/db/run.sh, which passes -v disposable=1.'
  DO $$ BEGIN RAISE EXCEPTION 'seed.sql refused: -v disposable=1 is required (disposable database only)'; END $$;
\endif

BEGIN;
SET LOCAL session_replication_role = replica;

-- Remove the previous scenario (cascades to stages, events and other children).
TRUNCATE public.financial_requests CASCADE;

INSERT INTO public.financial_requests (
  id, request_number, user_id, title, requester_email, department, funding_source, amount,
  needed_by, priority, description, status, workflow_revision, created_at, updated_at, metadata
)
SELECT
  (r ->> 'id')::UUID,
  'FR-SYN-' || (r ->> 'label'),
  :'owner'::UUID,
  'F19.5.5 synthetic ' || (r ->> 'label'),
  'synthetic@howard.edu',
  'Finance',
  'department',
  1000,
  DATE '2027-01-01',
  'medium',
  'F19.5.5 synthetic scenario',
  (r ->> 'status')::public.request_status,
  (r ->> 'workflow_revision')::INTEGER,
  (r ->> 'created_at')::TIMESTAMPTZ,
  (r ->> 'created_at')::TIMESTAMPTZ,
  jsonb_build_object(
    'schemaVersion', 1,
    'requestNumber', 'FR-SYN-' || (r ->> 'label'),
    'userId', :'owner',
    'derived', '{}'::JSONB,
    'attachments', '[]'::JSONB
  )
FROM jsonb_array_elements((:'data')::JSONB -> 'requests') AS r;

INSERT INTO public.approval_stage_tracking (
  id, request_id, workflow_revision, stage_order, queue_id, stage_name, status,
  started_at, completed_at, duration_hours, deadline_at, created_at, updated_at
)
SELECT
  (s ->> 'id')::UUID,
  (s ->> 'request_id')::UUID,
  (s ->> 'workflow_revision')::INTEGER,
  (s ->> 'stage_order')::INTEGER,
  s ->> 'queue_id',
  'F19.5.5 ' || (s ->> 'label'),
  s ->> 'status',
  (s ->> 'started_at')::TIMESTAMPTZ,
  (s ->> 'completed_at')::TIMESTAMPTZ,
  24,
  (s ->> 'started_at')::TIMESTAMPTZ + INTERVAL '24 hours',
  (s ->> 'started_at')::TIMESTAMPTZ,
  (s ->> 'started_at')::TIMESTAMPTZ
FROM jsonb_array_elements((:'data')::JSONB -> 'stages') AS s;

COMMIT;
