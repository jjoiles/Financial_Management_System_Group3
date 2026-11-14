-- ============================================================
-- F16: APPROVAL DECISION PROCESSING
-- ============================================================
--
-- Records approval and rejection decisions.
-- Completes the current SLA stage.
-- Creates the next SLA stage after an approval.
-- Updates the request status when the chain ends.
-- Records every decision in workflow_events.
--
-- SLA durations below are provisional and must remain
-- synchronized with src/lib/sla-config.ts.
--
-- ============================================================


CREATE OR REPLACE FUNCTION public.f16_record_approval_decision(
    _request_id UUID,
    _stage_id UUID,
    _decision TEXT,
    _comment TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$

DECLARE
    request_row RECORD;
    current_stage RECORD;

    approval_chain JSONB;
    current_step JSONB;
    next_step JSONB;

    next_queue TEXT;
    next_stage_name TEXT;
    next_stage_id UUID;
    next_stage_order INTEGER;
    next_stage_duration NUMERIC(10,2);

    active_stage_count INTEGER;

    decision_timestamp TIMESTAMPTZ := now();
    final_stage BOOLEAN := FALSE;
    resulting_status public.request_status;

    event_type_value TEXT;
    event_message TEXT;
    cleaned_comment TEXT;

BEGIN

    -- ========================================================
    -- 1. Validate the incoming decision.
    -- ========================================================

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF _decision IS NULL OR _decision NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'Decision must be approve or reject.';
    END IF;

    IF _comment IS NOT NULL AND char_length(_comment) > 2000 THEN
        RAISE EXCEPTION 'Decision comments cannot exceed 2000 characters.';
    END IF;

    cleaned_comment := NULLIF(btrim(_comment), '');

    -- ========================================================
    -- 2. Verify reviewer authorization.
    -- ========================================================

    IF NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.role IN (
              'admin'::public.app_role,
              'reviewer'::public.app_role,
              'leadership'::public.app_role
          )
    ) THEN
        RAISE EXCEPTION 'You are not authorized to make approval decisions.';
    END IF;

    -- ========================================================
    -- 3. Lock the request to prevent concurrent decisions.
    -- ========================================================

    SELECT *
    INTO request_row
    FROM public.financial_requests
    WHERE id = _request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Financial request not found.';
    END IF;

    IF request_row.status NOT IN (
        'submitted'::public.request_status,
        'under_review'::public.request_status
    ) THEN
        RAISE EXCEPTION
            'Request is not open for approval. Current status: %.',
            request_row.status;
    END IF;

    -- ========================================================
    -- 4. Lock the specific active SLA stage.
    --
    -- Requiring the caller to provide the stage ID prevents
    -- a duplicate request from accidentally deciding the
    -- following stage.
    -- ========================================================

    SELECT *
    INTO current_stage
    FROM public.approval_stage_tracking
    WHERE id = _stage_id
      AND request_id = _request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Approval stage not found for this request.';
    END IF;

    IF current_stage.status <> 'active' THEN
        RAISE EXCEPTION 'This approval stage is no longer active.';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO active_stage_count
    FROM public.approval_stage_tracking
    WHERE request_id = _request_id
      AND status = 'active';

    IF active_stage_count <> 1 THEN
        RAISE EXCEPTION
            'Expected exactly one active approval stage, but found %.',
            active_stage_count;
    END IF;

    -- ========================================================
    -- 5. Validate the saved approval chain.
    -- ========================================================

    approval_chain := request_row.metadata
        #> '{routing,approvalChain}';

    IF jsonb_typeof(approval_chain) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'The saved approval chain is missing or invalid.';
    END IF;

    current_step := approval_chain -> (current_stage.stage_order - 1);

    IF current_step IS NULL
       OR current_step ->> 'queue' IS DISTINCT FROM current_stage.queue_id
       OR current_step ->> 'label' IS DISTINCT FROM current_stage.stage_name
    THEN
        RAISE EXCEPTION
            'The active SLA stage does not match the saved approval chain.';
    END IF;

    -- ========================================================
    -- 6. Complete the current SLA stage.
    --
    -- Rejected decisions are recorded as completed stages
    -- because the existing stage status constraint does not
    -- include a rejected value. The request status and event
    -- record preserve the actual rejection decision.
    -- ========================================================

    UPDATE public.approval_stage_tracking
    SET
        status = 'completed',
        completed_at = decision_timestamp
    WHERE id = _stage_id
      AND request_id = _request_id
      AND status = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Could not complete the active approval stage.';
    END IF;

    -- ========================================================
    -- 7. Handle rejection.
    -- ========================================================

    IF _decision = 'reject' THEN

        resulting_status := 'rejected';

        UPDATE public.financial_requests
        SET status = resulting_status
        WHERE id = _request_id;

        event_type_value := 'approval_rejected';

        event_message := format(
            'Request rejected at %s.',
            current_stage.stage_name
        );

        INSERT INTO public.workflow_events (
            request_id,
            actor_user_id,
            event_type,
            message,
            metadata
        )
        VALUES (
            _request_id,
            auth.uid(),
            event_type_value,
            event_message,
            jsonb_build_object(
                'decision', _decision,
                'stageId', current_stage.id,
                'stageOrder', current_stage.stage_order,
                'queueId', current_stage.queue_id,
                'stageName', current_stage.stage_name,
                'comment', cleaned_comment,
                'decidedAt', decision_timestamp
            )
        );

        RETURN jsonb_build_object(
            'requestId', _request_id,
            'stageId', current_stage.id,
            'stageOrder', current_stage.stage_order,
            'decision', _decision,
            'requestStatus', resulting_status::TEXT,
            'nextStageId', NULL,
            'nextStageOrder', NULL,
            'nextQueueId', NULL,
            'finalStage', FALSE
        );

    END IF;

    -- ========================================================
    -- 8. Determine the next approval stage.
    --
    -- The JSON array is zero-indexed:
    -- stage_order 1 is array index 0.
    -- The next stage after stage 1 is array index 1.
    -- ========================================================

    next_step := approval_chain -> current_stage.stage_order;

    IF next_step IS NULL OR next_step = 'null'::JSONB THEN

        -- No additional approvers remain.
        final_stage := TRUE;

        resulting_status := 'approved';

        UPDATE public.financial_requests
        SET status = resulting_status
        WHERE id = _request_id;

        event_type_value := 'approval_approved';

        event_message := format(
            'Request approved at %s. The approval chain is complete.',
            current_stage.stage_name
        );

    ELSE

        -- Retrieve the next queue and stage name.
        next_queue := next_step ->> 'queue';
        next_stage_name := next_step ->> 'label';

        next_stage_order := current_stage.stage_order + 1;

        IF next_queue IS NULL OR next_stage_name IS NULL THEN
            RAISE EXCEPTION 'The next approval stage is missing required information.';
        END IF;

        -- ====================================================
        -- 9. Get the next stage's provisional SLA duration.
        -- ====================================================

        next_stage_duration := CASE next_queue
            WHEN 'department_budget' THEN 72
            WHEN 'research_admin' THEN 72
            WHEN 'provost_finance' THEN 72
            WHEN 'sponsored_programs' THEN 96
            WHEN 'dean_office' THEN 72
            WHEN 'cfo_office' THEN 48
            ELSE NULL
        END;

        IF next_stage_duration IS NULL THEN
            RAISE EXCEPTION
                'No SLA duration configured for queue %.',
                next_queue;
        END IF;

        -- ====================================================
        -- 10. Create the next active SLA stage.
        -- ====================================================

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
            next_stage_order,
            next_queue,
            next_stage_name,
            decision_timestamp,
            next_stage_duration,
            decision_timestamp + (
                next_stage_duration * INTERVAL '1 hour'
            ),
            'active'
        )
        RETURNING id INTO next_stage_id;

        resulting_status := 'under_review';

        UPDATE public.financial_requests
        SET
            status = resulting_status,
            routed_to = next_stage_name
        WHERE id = _request_id;

        event_type_value := 'approval_approved';

        event_message := format(
            'Request approved at %s and advanced to %s.',
            current_stage.stage_name,
            next_stage_name
        );

    END IF;

    -- ========================================================
    -- 11. Record the approval decision.
    -- ========================================================

    INSERT INTO public.workflow_events (
        request_id,
        actor_user_id,
        event_type,
        message,
        metadata
    )
    VALUES (
        _request_id,
        auth.uid(),
        event_type_value,
        event_message,
        jsonb_build_object(
            'decision', _decision,
            'stageId', current_stage.id,
            'stageOrder', current_stage.stage_order,
            'queueId', current_stage.queue_id,
            'stageName', current_stage.stage_name,
            'comment', cleaned_comment,
            'decidedAt', decision_timestamp,
            'finalStage', final_stage,
            'nextStageId', next_stage_id,
            'nextStageOrder', next_stage_order,
            'nextQueueId', next_queue
        )
    );

    -- ========================================================
    -- 12. Return the result.
    -- ========================================================

    RETURN jsonb_build_object(
        'requestId', _request_id,
        'stageId', current_stage.id,
        'stageOrder', current_stage.stage_order,
        'decision', _decision,
        'requestStatus', resulting_status::TEXT,
        'nextStageId', next_stage_id,
        'nextStageOrder', next_stage_order,
        'nextQueueId', next_queue,
        'finalStage', final_stage
    );

END;
$$;


-- ============================================================
-- FUNCTION PERMISSIONS
-- ============================================================

REVOKE ALL
ON FUNCTION public.f16_record_approval_decision(
    UUID,
    UUID,
    TEXT,
    TEXT
)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.f16_record_approval_decision(
    UUID,
    UUID,
    TEXT,
    TEXT
)
FROM anon;

GRANT EXECUTE
ON FUNCTION public.f16_record_approval_decision(
    UUID,
    UUID,
    TEXT,
    TEXT
)
TO authenticated;


-- ============================================================
-- END F16 APPROVAL DECISION PROCESSING
-- ============================================================
