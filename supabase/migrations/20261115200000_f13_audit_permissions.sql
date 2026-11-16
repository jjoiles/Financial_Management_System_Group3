-- F13: Enforce audit event permissions.
-- Authorized users may read permitted request history.
-- Application clients cannot directly insert, update, delete, or truncate
-- historical audit records. Trusted database functions and triggers
-- continue recording events using SECURITY DEFINER.

ALTER TABLE public.workflow_events ENABLE ROW LEVEL SECURITY;

-- Rebuild the read policy with explicit request ownership and reviewer access.
DROP POLICY IF EXISTS "Users can view workflow events for permitted requests"
ON public.workflow_events;

CREATE POLICY "Authorized users can view permitted audit history"
ON public.workflow_events
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.financial_requests fr
    WHERE fr.id = workflow_events.request_id
      AND (
        fr.user_id = auth.uid()
        OR public.is_admin_or_reviewer(auth.uid())
      )
  )
);

-- Remove direct client-side event creation policies.
DROP POLICY IF EXISTS "Users can create workflow events for own requests"
ON public.workflow_events;

DROP POLICY IF EXISTS "Reviewers can create workflow events"
ON public.workflow_events;

-- Remove any direct client-side modification policies.
DROP POLICY IF EXISTS "Users can update workflow events"
ON public.workflow_events;

DROP POLICY IF EXISTS "Users can delete workflow events"
ON public.workflow_events;

-- Explicitly make the table read-only for regular application roles.
REVOKE ALL PRIVILEGES ON TABLE public.workflow_events
FROM PUBLIC, anon, authenticated;

-- Authenticated users can read only events allowed by the SELECT policy.
GRANT SELECT ON TABLE public.workflow_events TO authenticated;

-- No client-side INSERT, UPDATE, DELETE, or TRUNCATE privileges are granted.
-- Existing SECURITY DEFINER database triggers and procedures continue
-- writing audit events using their database-owner privileges.
