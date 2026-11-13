
-- ============================================================
-- F16: SLA STAGE TRACKING
-- ============================================================

-- Creates a history of approval stages and their SLA deadlines.

CREATE TABLE IF NOT EXISTS public.approval_stage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  request_id UUID NOT NULL
    REFERENCES public.financial_requests(id)
    ON DELETE CASCADE,

  stage_order INTEGER NOT NULL CHECK (stage_order >= 1),

  queue_id TEXT NOT NULL,

  stage_name TEXT NOT NULL,

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  duration_hours NUMERIC(10,2) NOT NULL
    CHECK (duration_hours >= 0),

  deadline_at TIMESTAMPTZ NOT NULL,

  completed_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'completed',
        'skipped',
        'cancelled'
      )
    ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT approval_stage_tracking_request_stage_unique
    UNIQUE (request_id, stage_order),

  CONSTRAINT approval_stage_tracking_completion_check
    CHECK (
      completed_at IS NULL
      OR completed_at >= started_at
    )
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_approval_stage_tracking_request
  ON public.approval_stage_tracking (request_id, stage_order);

CREATE INDEX IF NOT EXISTS idx_approval_stage_tracking_active_deadline
  ON public.approval_stage_tracking (deadline_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_approval_stage_tracking_status
  ON public.approval_stage_tracking (status);

-- ============================================================
-- UPDATED AT TRIGGER
-- ============================================================

DROP TRIGGER IF EXISTS update_approval_stage_tracking_updated_at
  ON public.approval_stage_tracking;

CREATE TRIGGER update_approval_stage_tracking_updated_at
  BEFORE UPDATE ON public.approval_stage_tracking
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.approval_stage_tracking
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requesters and reviewers can view approval stage tracking"
  ON public.approval_stage_tracking;

CREATE POLICY "Requesters and reviewers can view approval stage tracking"
ON public.approval_stage_tracking
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.financial_requests fr
    WHERE fr.id = approval_stage_tracking.request_id
      AND (
        fr.user_id = auth.uid()
        OR public.is_admin_or_reviewer(auth.uid())
      )
  )
);

DROP POLICY IF EXISTS "Reviewers can insert approval stage tracking"
  ON public.approval_stage_tracking;

CREATE POLICY "Reviewers can insert approval stage tracking"
ON public.approval_stage_tracking
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_admin_or_reviewer(auth.uid())
);

DROP POLICY IF EXISTS "Reviewers can update approval stage tracking"
  ON public.approval_stage_tracking;

CREATE POLICY "Reviewers can update approval stage tracking"
ON public.approval_stage_tracking
FOR UPDATE
TO authenticated
USING (
  public.is_admin_or_reviewer(auth.uid())
)
WITH CHECK (
  public.is_admin_or_reviewer(auth.uid())
);

DROP POLICY IF EXISTS "Reviewers can delete approval stage tracking"
  ON public.approval_stage_tracking;

CREATE POLICY "Reviewers can delete approval stage tracking"
ON public.approval_stage_tracking
FOR DELETE
TO authenticated
USING (
  public.is_admin_or_reviewer(auth.uid())
);

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.approval_stage_tracking
TO authenticated;

-- ============================================================
-- SECURE INITIAL APPROVAL STAGE CREATION
-- ============================================================

-- Starts the first approval stage using the saved routing decision.
-- The function verifies that the caller owns the request or has
-- an authorized reviewer, administrator, or leadership role.

-- These are provisional SLA defaults. They must remain synchronized
-- with src/lib/sla-config.ts until a shared database configuration
-- table is implemented.

CREATE OR REPLACE FUNCTION public.f16_start_initial_approval_stage(
  _request_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$

DECLARE
  request_row RECORD;
  initial_queue TEXT;
  initial_stage_name TEXT;
  stage_duration NUMERIC(10,2);
  stage_id UUID;
  stage_started_at TIMESTAMPTZ := now();

BEGIN

  -- Load the requested financial record.

  SELECT id, user_id, status, routed_to, metadata
  INTO request_row
  FROM public.financial_requests
  WHERE id = _request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial request not found.';
  END IF;

  -- Verify the caller is authenticated and authorized.
  -- Check roles directly to avoid executing the restricted
  -- is_admin_or_reviewer helper function.

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

  -- Only active requests can begin approval-stage tracking.

  IF request_row.status NOT IN ('submitted', 'under_review') THEN
    RAISE EXCEPTION 'Request is not eligible for SLA tracking.';
  END IF;

  -- Read the first approval queue from the saved routing decision.

  initial_queue :=
    request_row.metadata #>> '{routing,primaryQueue}';

  initial_stage_name := request_row.routed_to;

  IF initial_queue IS NULL OR initial_stage_name IS NULL THEN
    RAISE EXCEPTION 'Request routing information is missing.';
  END IF;

  -- Retrieve the provisional SLA duration for the first queue.

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

  -- Create the first stage.
  -- The unique constraint prevents duplicate stage records.

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
    stage_started_at + (stage_duration * interval '1 hour'),
    'active'
  )

  ON CONFLICT (request_id, stage_order) DO NOTHING

  RETURNING id INTO stage_id;

  -- If the stage already exists, return its existing ID.

  IF stage_id IS NULL THEN
    SELECT id
    INTO stage_id
    FROM public.approval_stage_tracking
    WHERE request_id = _request_id
      AND stage_order = 1;
  END IF;

  RETURN stage_id;

END;
$$;

-- ============================================================
-- FUNCTION PERMISSIONS
-- ============================================================

REVOKE ALL
ON FUNCTION public.f16_start_initial_approval_stage(UUID)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.f16_start_initial_approval_stage(UUID)
FROM anon;

GRANT EXECUTE
ON FUNCTION public.f16_start_initial_approval_stage(UUID)
TO authenticated;

-- ============================================================
-- END F16 SLA STAGE TRACKING
-- ============================================================
