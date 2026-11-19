-- ============================================================
-- F19.2 follow-up: decision status guard
-- ============================================================
--
-- Additive to 20261119030549_f19_2_workflow_integrity.sql, which is not
-- edited. Two layers protect recorded approval decisions:
--
-- Layer 1: f19_amend_request_workflow only amends requests that are still
--   awaiting a decision (submitted or under_review). The function body is the
--   F19.2 body unchanged, plus one eligibility check placed after the row lock
--   and authorization check and before workflow-initialization validation.
--
-- Layer 2: zz_f19_guard_request_status, a BEFORE INSERT OR UPDATE trigger on
--   financial_requests, enforces:
--   R1 approved, rejected and completed are final for every caller; no status
--      change away from them is allowed, including approved -> completed.
--   R2 API callers (any role other than the table owner, including
--      service_role) may not change status, and may only insert submitted
--      requests.
--   R3 trusted callers may only make the workflow transitions
--      submitted -> under_review, under_review -> submitted, and
--      submitted/under_review -> approved/rejected.
--   R4 a trusted move to approved or rejected requires no active stage and a
--      completed final stage (highest stage_order) in the request's current
--      workflow_revision, so every new decision has a stage-backed decision
--      instant.
--
-- Trust model. The trigger function is SECURITY INVOKER, so current_user is
-- the role executing the statement:
--   * a direct PostgREST write runs as anon, authenticated or service_role,
--     chosen from the signed JWT; those roles cannot SET ROLE to the owner;
--   * a write inside a SECURITY DEFINER workflow function
--     (f16_record_approval_decision, f19_amend_request_workflow) runs as the
--     function owner, which is the table owner.
-- The owner is read from pg_class at run time, not hard-coded. Custom
-- settings such as app.f19_trusted_workflow_write are deliberately NOT used
-- as proof of trust: any role can set a custom app.* setting.
--
-- The trigger is named to fire after every other BEFORE trigger on the table
-- (triggers fire in name order), so it validates the final NEW.status.
--
-- Deliberately disabling the trigger (ALTER TABLE ... DISABLE TRIGGER, which
-- requires the owner) is the only way to change a final status.

-- ------------------------------------------------------------
-- Layer 1: amendment eligibility
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f19_amend_request_workflow(
	_request_id UUID,
	_amount NUMERIC,
	_funding_source public.funding_source,
	_grant_number TEXT,
	_principal_investigator TEXT,
	_university_program TEXT,
	_routed_to TEXT,
	_routing JSONB,
	_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	request_row RECORD;
	stage_id UUID;
	routing_primary_queue TEXT;
	routing_primary_label TEXT;
	approval_chain_length INTEGER;
	chain_entry RECORD;
	chain_step_raw TEXT;
	chain_step_num INTEGER;
	chain_step_queue TEXT;
	chain_step_label TEXT;
	prior_values JSONB;
	new_values JSONB;
	changed_fields TEXT[] := ARRAY[]::TEXT[];
	next_revision INTEGER;
BEGIN
	IF auth.uid() IS NULL THEN
		RAISE EXCEPTION 'Authentication is required.';
	END IF;

	SELECT *
	INTO request_row
	FROM public.financial_requests
	WHERE id = _request_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Financial request not found.';
	END IF;

	IF request_row.user_id <> auth.uid()
		 AND NOT EXISTS (
			 SELECT 1
			 FROM public.user_roles ur
			 WHERE ur.user_id = auth.uid()
				 AND ur.role IN ('admin'::public.app_role, 'reviewer'::public.app_role, 'leadership'::public.app_role)
		 ) THEN
		RAISE EXCEPTION 'Not authorized to amend this request.';
	END IF;

	IF request_row.status NOT IN (
		'submitted'::public.request_status,
		'under_review'::public.request_status
	) THEN
		RAISE EXCEPTION
			'Only requests awaiting a decision can be amended. Current status: %.',
			request_row.status;
	END IF;

	IF NOT public.f19_request_has_initialized_workflow(_request_id, request_row.workflow_triggered_at) THEN
		RAISE EXCEPTION 'Request workflow has not been initialized.';
	END IF;

	IF _routed_to IS NULL OR btrim(_routed_to) = '' THEN
		RAISE EXCEPTION 'Amendment routing target is required.';
	END IF;

	routing_primary_queue := _routing ->> 'primaryQueue';
	routing_primary_label := _routing ->> 'primaryLabel';
	approval_chain_length := jsonb_array_length(_routing -> 'approvalChain');

	IF jsonb_typeof(_routing) IS DISTINCT FROM 'object'
		 OR jsonb_typeof(_routing -> 'approvalChain') IS DISTINCT FROM 'array'
		 OR routing_primary_queue IS NULL
		 OR routing_primary_label IS NULL
		 OR btrim(routing_primary_label) = ''
		 OR approval_chain_length < 1
		 OR NOT public.f19_is_valid_queue_id(routing_primary_queue)
	THEN
		RAISE EXCEPTION 'Amendment routing snapshot is invalid.';
	END IF;

	IF _routed_to IS DISTINCT FROM routing_primary_label THEN
		RAISE EXCEPTION 'Amendment routed_to must match routing.primaryLabel.';
	END IF;

	FOR chain_entry IN
		SELECT value, ordinality
		FROM jsonb_array_elements(_routing -> 'approvalChain') WITH ORDINALITY
	LOOP
		IF jsonb_typeof(chain_entry.value) IS DISTINCT FROM 'object' THEN
			RAISE EXCEPTION 'Amendment approvalChain entry % is not an object.', chain_entry.ordinality;
		END IF;

		chain_step_raw := chain_entry.value ->> 'step';
		chain_step_queue := chain_entry.value ->> 'queue';
		chain_step_label := chain_entry.value ->> 'label';

		IF chain_step_raw IS NULL OR chain_step_raw !~ '^[0-9]+$' THEN
			RAISE EXCEPTION 'Amendment approvalChain entry % has invalid step.', chain_entry.ordinality;
		END IF;

		chain_step_num := chain_step_raw::INTEGER;

		IF chain_step_num <> chain_entry.ordinality::INTEGER THEN
			RAISE EXCEPTION 'Amendment approvalChain step sequence is invalid at entry %.', chain_entry.ordinality;
		END IF;

		IF chain_step_queue IS NULL OR chain_step_label IS NULL OR btrim(chain_step_label) = '' THEN
			RAISE EXCEPTION 'Amendment approvalChain entry % is missing queue or label.', chain_entry.ordinality;
		END IF;

		IF NOT public.f19_is_valid_queue_id(chain_step_queue) THEN
			RAISE EXCEPTION 'Amendment approvalChain entry % has unsupported queue %.', chain_entry.ordinality, chain_step_queue;
		END IF;

		IF chain_entry.ordinality = 1 THEN
			IF chain_step_queue IS DISTINCT FROM routing_primary_queue
				OR chain_step_label IS DISTINCT FROM routing_primary_label
			THEN
				RAISE EXCEPTION 'Amendment primary routing must match approvalChain step 1.';
			END IF;
		END IF;
	END LOOP;

	prior_values := jsonb_build_object(
		'amount', request_row.amount,
		'funding_source', request_row.funding_source,
		'grant_number', request_row.grant_number,
		'principal_investigator', request_row.principal_investigator,
		'university_program', request_row.university_program,
		'routed_to', request_row.routed_to,
		'routing', request_row.metadata #> '{routing}'
	);

	new_values := jsonb_build_object(
		'amount', _amount,
		'funding_source', _funding_source,
		'grant_number', _grant_number,
		'principal_investigator', _principal_investigator,
		'university_program', _university_program,
		'routed_to', _routed_to,
		'routing', _routing
	);

	IF _amount IS DISTINCT FROM request_row.amount THEN
		changed_fields := array_append(changed_fields, 'amount');
	END IF;
	IF _funding_source IS DISTINCT FROM request_row.funding_source THEN
		changed_fields := array_append(changed_fields, 'funding_source');
	END IF;
	IF _grant_number IS DISTINCT FROM request_row.grant_number THEN
		changed_fields := array_append(changed_fields, 'grant_number');
	END IF;
	IF _principal_investigator IS DISTINCT FROM request_row.principal_investigator THEN
		changed_fields := array_append(changed_fields, 'principal_investigator');
	END IF;
	IF _university_program IS DISTINCT FROM request_row.university_program THEN
		changed_fields := array_append(changed_fields, 'university_program');
	END IF;
	IF _routed_to IS DISTINCT FROM request_row.routed_to THEN
		changed_fields := array_append(changed_fields, 'routed_to');
	END IF;
	IF _routing IS DISTINCT FROM (request_row.metadata -> 'routing') THEN
		changed_fields := array_append(changed_fields, 'metadata.routing');
	END IF;

	IF array_length(changed_fields, 1) IS NULL THEN
		RAISE EXCEPTION 'Amendment does not change protected fields.';
	END IF;

	next_revision := request_row.workflow_revision + 1;

	UPDATE public.approval_stage_tracking
	SET
		status = 'cancelled',
		completed_at = now()
	WHERE request_id = _request_id
		AND status = 'active';

	PERFORM set_config('app.f19_allow_amendment_write', 'on', true);
	PERFORM set_config('app.f19_trusted_workflow_write', 'on', true);

	UPDATE public.financial_requests
	SET
		amount = _amount,
		funding_source = _funding_source,
		grant_number = _grant_number,
		principal_investigator = _principal_investigator,
		university_program = _university_program,
		routed_to = _routed_to,
		metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{routing}', _routing, true),
		workflow_revision = next_revision,
		status = 'submitted',
		workflow_triggered_at = NULL
	WHERE id = _request_id;

	INSERT INTO public.request_workflow_amendments (
		request_id,
		previous_revision,
		new_revision,
		reason,
		changed_fields,
		previous_values,
		new_values,
		metadata,
		amended_by
	) VALUES (
		_request_id,
		request_row.workflow_revision,
		next_revision,
		NULLIF(btrim(_reason), ''),
		changed_fields,
		prior_values,
		new_values,
		jsonb_build_object(
			'source', 'f19_amend_request_workflow',
			'cancelledActiveStages', (
				SELECT COUNT(*)::INTEGER
				FROM public.approval_stage_tracking ast
				WHERE ast.request_id = _request_id
					AND ast.workflow_revision = request_row.workflow_revision
					AND ast.status = 'cancelled'
			)
		),
		auth.uid()
	);

	INSERT INTO public.workflow_events (
		request_id,
		actor_user_id,
		event_type,
		message,
		metadata
	) VALUES (
		_request_id,
		auth.uid(),
		'request_amended',
		'Request amended and approval workflow restarted.',
		jsonb_build_object(
			'source', 'f19_amend_request_workflow',
			'previousRevision', request_row.workflow_revision,
			'newRevision', next_revision,
			'changedFields', changed_fields,
			'reason', NULLIF(btrim(_reason), '')
		)
	);

	INSERT INTO public.workflow_initialization_state (
		request_id,
		status,
		request_revision,
		claim_token,
		claimed_by,
		claimed_at,
		claim_expires_at,
		completed_at,
		completion_mode,
		routing_snapshot,
		last_error
	) VALUES (
		_request_id,
		'idle',
		next_revision,
		NULL,
		NULL,
		NULL,
		NULL,
		NULL,
		NULL,
		_routing,
		NULL
	)
	ON CONFLICT (request_id)
	DO UPDATE SET
		status = EXCLUDED.status,
		request_revision = EXCLUDED.request_revision,
		claim_token = NULL,
		claimed_by = NULL,
		claimed_at = NULL,
		claim_expires_at = NULL,
		completed_at = NULL,
		completion_mode = NULL,
		routing_snapshot = EXCLUDED.routing_snapshot,
		delivery_uncertain = FALSE,
		last_error = NULL;

	-- Restart the approval chain at stage 1 for the new revision.
	stage_id := public.f16_start_initial_approval_stage(_request_id);

	UPDATE public.financial_requests
	SET
		status = 'under_review',
		workflow_triggered_at = now()
	WHERE id = _request_id;

	UPDATE public.workflow_initialization_state
	SET
		status = 'completed',
		completion_mode = 'simulated',
		completed_at = now()
	WHERE request_id = _request_id;

	RETURN jsonb_build_object(
		'requestId', _request_id,
		'previousRevision', request_row.workflow_revision,
		'newRevision', next_revision,
		'initialStageId', stage_id
	);
END;
$$;

REVOKE ALL ON FUNCTION public.f19_amend_request_workflow(
	UUID,
	NUMERIC,
	public.funding_source,
	TEXT,
	TEXT,
	TEXT,
	TEXT,
	JSONB,
	TEXT
)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.f19_amend_request_workflow(
	UUID,
	NUMERIC,
	public.funding_source,
	TEXT,
	TEXT,
	TEXT,
	TEXT,
	JSONB,
	TEXT
)
TO authenticated;

-- ------------------------------------------------------------
-- Layer 2: request status guard
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f19_guard_request_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
	trusted BOOLEAN;
	final_stage_status TEXT;
BEGIN
	-- Trusted only when executing as the table owner: inside the SECURITY
	-- DEFINER workflow functions, or an owner maintenance session.
	SELECT pg_catalog.pg_get_userbyid(c.relowner) = current_user
	INTO trusted
	FROM pg_catalog.pg_class c
	WHERE c.oid = TG_RELID;

	trusted := COALESCE(trusted, FALSE);

	IF TG_OP = 'INSERT' THEN
		-- R2: API callers cannot create a request in a decided or reviewed state.
		IF NOT trusted
			 AND NEW.status IS DISTINCT FROM 'submitted'::public.request_status
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'insufficient_privilege',
				MESSAGE = 'New financial requests must start in submitted status.';
		END IF;

		RETURN NEW;
	END IF;

	IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;

	-- R1: final statuses never change, for any caller.
	IF OLD.status IN (
		'approved'::public.request_status,
		'rejected'::public.request_status,
		'completed'::public.request_status
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'check_violation',
			MESSAGE = format(
				'Request status %s is final and cannot change to %s.',
				OLD.status,
				NEW.status
			);
	END IF;

	-- R2: only the approval workflow functions may change status.
	IF NOT trusted THEN
		RAISE EXCEPTION USING
			ERRCODE = 'insufficient_privilege',
			MESSAGE = 'Request status can only change through the approval workflow.';
	END IF;

	-- R3: the transitions the workflow functions make.
	IF NOT (
		(
			OLD.status = 'submitted'::public.request_status
			AND NEW.status IN (
				'under_review'::public.request_status,
				'approved'::public.request_status,
				'rejected'::public.request_status
			)
		)
		OR (
			OLD.status = 'under_review'::public.request_status
			AND NEW.status IN (
				'submitted'::public.request_status,
				'approved'::public.request_status,
				'rejected'::public.request_status
			)
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'check_violation',
			MESSAGE = format(
				'Request status transition %s -> %s is not permitted.',
				OLD.status,
				NEW.status
			);
	END IF;

	-- R4: a decision must be backed by the completed final stage of the
	-- current workflow revision, with no stage left active.
	IF NEW.status IN (
		'approved'::public.request_status,
		'rejected'::public.request_status
	) THEN
		IF EXISTS (
			SELECT 1
			FROM public.approval_stage_tracking ast
			WHERE ast.request_id = NEW.id
				AND ast.status = 'active'
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = 'check_violation',
				MESSAGE = 'A request cannot be decided while an approval stage is still active.';
		END IF;

		SELECT ast.status
		INTO final_stage_status
		FROM public.approval_stage_tracking ast
		WHERE ast.request_id = NEW.id
			AND ast.workflow_revision = NEW.workflow_revision
		ORDER BY ast.stage_order DESC
		LIMIT 1;

		IF final_stage_status IS DISTINCT FROM 'completed' THEN
			RAISE EXCEPTION USING
				ERRCODE = 'check_violation',
				MESSAGE = 'A request can only be decided after the final stage of its current workflow revision is completed.';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.f19_guard_request_status() IS
	'F19.2 decision status guard. SECURITY INVOKER by design: current_user identifies the caller. See migration 20261119072711.';

-- Trigger functions need no EXECUTE grant to fire; no API role may call it.
REVOKE ALL ON FUNCTION public.f19_guard_request_status()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS zz_f19_guard_request_status ON public.financial_requests;
CREATE TRIGGER zz_f19_guard_request_status
BEFORE INSERT OR UPDATE ON public.financial_requests
FOR EACH ROW
EXECUTE FUNCTION public.f19_guard_request_status();
