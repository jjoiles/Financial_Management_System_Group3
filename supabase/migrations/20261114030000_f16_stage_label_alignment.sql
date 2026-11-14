CREATE OR REPLACE FUNCTION public.f16_start_initial_approval_stage(
  _request_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$

DECLARE
  request_row RECORD;
  initial_queue TEXT;
  initial_stage_name TEXT;
  stage_duration NUMERIC(10,2);
  stage_id UUID;
  stage_started_at TIMESTAMPTZ := now();

BEGIN

  -- Load the financial request.
  SELECT id, user_id, status, routed_to, metadata
  INTO request_row
  FROM public.financial_requests
  WHERE id = _request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial request not found.';
  END IF;

  -- Verify authentication and authorization.
  IF auth.uid() IS NULL OR (
    request_row.user_id <> auth.uid()
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN (
          'admin'::public.app_role,
          'reviewer'::public.app_role,
          'leadership'::public.app_role
        )
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to start SLA tracking.';
  END IF;

  -- Only active requests can begin SLA tracking.
  IF request_row.status NOT IN ('submitted', 'under_review') THEN
    RAISE EXCEPTION 'Request is not eligible for SLA tracking.';
  END IF;

  -- Require a complete saved approval chain.
  IF jsonb_typeof(
    request_row.metadata #> '{routing,approvalChain}'
  ) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Request approval chain is missing or invalid.';
  END IF;

  -- Read the first queue and its canonical approval-chain label.
  initial_queue :=
    request_row.metadata #>> '{routing,primaryQueue}';

  initial_stage_name :=
    request_row.metadata #>> '{routing,approvalChain,0,label}';

  -- Verify that the first approval-chain entry matches the primary queue.
  IF initial_queue IS NULL
     OR initial_stage_name IS NULL
     OR request_row.metadata #>> '{routing,approvalChain,0,queue}'
        IS DISTINCT FROM initial_queue
     OR request_row.metadata #>> '{routing,primaryLabel}'
        IS DISTINCT FROM initial_stage_name
  THEN
    RAISE EXCEPTION 'Request routing and approval chain do not match.';
  END IF;

  -- Retrieve the provisional SLA duration.
  stage_duration := CASE initial_queue
    WHEN 'department_budget' THEN 72
    WHEN 'research_admin' THEN 72
    WHEN 'provost_finance' THEN 72
    WHEN 'sponsored_programs' THEN 96
    WHEN 'dean_office' THEN 72
    WHEN 'cfo_office' THEN 48
    ELSE NULL
  END;

  IF stage_duration IS NULL THEN
    RAISE EXCEPTION
      'No SLA duration configured for queue %.',
      initial_queue;
  END IF;

  -- Create the first approval stage using the canonical label.
  INSERT INTO public.approval_stage_tracking (
    request_id,
    stage_order,
    queue_id,
    stage_name,
    started_at,
    duration_hours,
    deadline_at,
    status
  )
  VALUES (
    _request_id,
    1,
    initial_queue,
    initial_stage_name,
    stage_started_at,
    stage_duration,
    stage_started_at + (
      stage_duration * INTERVAL '1 hour'
    ),
    'active'
  )
  ON CONFLICT (request_id, stage_order) DO NOTHING
  RETURNING id INTO stage_id;

  -- Return the existing stage ID when already initialized.
  IF stage_id IS NULL THEN
    SELECT id
    INTO stage_id
    FROM public.approval_stage_tracking
    WHERE request_id = _request_id
      AND stage_order = 1;
  END IF;

  RETURN stage_id;

END;
$function$;
