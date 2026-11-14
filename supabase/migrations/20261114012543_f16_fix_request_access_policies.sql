-- ============================================================
-- F16: FIX REQUEST ACCESS POLICIES
-- ============================================================
--
-- Replaces legacy authorization helper calls with secure
-- F16 SECURITY DEFINER helpers.
--
-- Preserves requester ownership and reviewer permissions.
--
-- ============================================================


-- ============================================================
-- 1. FINANCIAL REQUESTS
-- ============================================================

DROP POLICY IF EXISTS
    "Requesters can view their own requests"
ON public.financial_requests;

CREATE POLICY "Requesters can view their own requests"
ON public.financial_requests
FOR SELECT
TO authenticated
USING (
    auth.uid() = user_id
    OR public.f16_is_admin_or_reviewer()
);


DROP POLICY IF EXISTS
    "Requesters can edit own submitted requests"
ON public.financial_requests;

CREATE POLICY "Requesters can edit own submitted requests"
ON public.financial_requests
FOR UPDATE
TO authenticated
USING (
    (
        auth.uid() = user_id
        AND status = 'submitted'::public.request_status
    )
    OR public.f16_is_admin_or_reviewer()
)
WITH CHECK (
    (
        auth.uid() = user_id
        AND status = 'submitted'::public.request_status
    )
    OR public.f16_is_admin_or_reviewer()
);


-- ============================================================
-- 2. REQUEST ATTACHMENTS
-- ============================================================

DROP POLICY IF EXISTS
    "Users can view permitted attachments"
ON public.request_attachments;

CREATE POLICY "Users can view permitted attachments"
ON public.request_attachments
FOR SELECT
TO authenticated
USING (
    auth.uid() = user_id
    OR public.f16_is_admin_or_reviewer()
);


DROP POLICY IF EXISTS
    "Users can remove own attachments"
ON public.request_attachments;

CREATE POLICY "Users can remove own attachments"
ON public.request_attachments
FOR DELETE
TO authenticated
USING (
    auth.uid() = user_id
    OR public.f16_is_admin()
);


-- ============================================================
-- 3. WORKFLOW EVENTS
-- ============================================================

DROP POLICY IF EXISTS
    "Reviewers can create workflow events"
ON public.workflow_events;

CREATE POLICY "Reviewers can create workflow events"
ON public.workflow_events
FOR INSERT
TO authenticated
WITH CHECK (
    public.f16_is_admin_or_reviewer()
);


DROP POLICY IF EXISTS
    "Users can create workflow events for own requests"
ON public.workflow_events;

CREATE POLICY "Users can create workflow events for own requests"
ON public.workflow_events
FOR INSERT
TO authenticated
WITH CHECK (
    actor_user_id = auth.uid()
    AND EXISTS (
        SELECT 1
        FROM public.financial_requests fr
        WHERE fr.id = workflow_events.request_id
          AND fr.user_id = auth.uid()
    )
);


DROP POLICY IF EXISTS
    "Users can view workflow events for permitted requests"
ON public.workflow_events;

CREATE POLICY "Users can view workflow events for permitted requests"
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
              OR public.f16_is_admin_or_reviewer()
          )
    )
);


-- ============================================================
-- END F16 REQUEST ACCESS POLICY FIX
-- ============================================================
