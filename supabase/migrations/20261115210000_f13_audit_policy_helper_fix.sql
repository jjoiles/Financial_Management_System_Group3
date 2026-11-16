-- F13: Use the existing authorized SECURITY DEFINER helper.
-- This avoids calling the restricted legacy is_admin_or_reviewer function
-- from the workflow_events row-level security policy.

DROP POLICY IF EXISTS
  "Authorized users can view permitted audit history"
ON public.workflow_events;

GRANT EXECUTE
ON FUNCTION public.f16_can_view_approval_stage(UUID)
TO authenticated;

CREATE POLICY "Authorized users can view permitted audit history"
ON public.workflow_events
FOR SELECT
TO authenticated
USING (
  public.f16_can_view_approval_stage(request_id)
);
