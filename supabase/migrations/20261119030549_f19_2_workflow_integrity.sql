-- ============================================================
-- F19.2: WORKFLOW STAGE EVENT CAPTURE + INTEGRITY HARDENING
-- ============================================================

-- ------------------------------------------------------------
-- Checkpoint 1: stage integrity + preflight reporting
-- ------------------------------------------------------------

ALTER TABLE public.financial_requests
	ADD COLUMN IF NOT EXISTS workflow_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.approval_stage_tracking
	ADD COLUMN IF NOT EXISTS workflow_revision INTEGER;

UPDATE public.approval_stage_tracking
SET workflow_revision = 1
WHERE workflow_revision IS NULL;

ALTER TABLE public.approval_stage_tracking
	ALTER COLUMN workflow_revision SET NOT NULL,
	ALTER COLUMN workflow_revision SET DEFAULT 1;

-- Queue allowlist helper (routing engine remains authoritative in TS).
CREATE OR REPLACE FUNCTION public.f19_is_valid_queue_id(_queue_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
	SELECT _queue_id IN (
		'department_budget',
		'research_admin',
		'provost_finance',
		'sponsored_programs',
		'dean_office',
		'cfo_office'
	);
$$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public.approval_stage_tracking ast
		WHERE NOT public.f19_is_valid_queue_id(ast.queue_id)
	) THEN
		RAISE EXCEPTION
			'F19.2 preflight failed: approval_stage_tracking contains unknown queue_id values.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public.approval_stage_tracking ast
		WHERE ast.status = 'active'
			AND EXISTS (
				SELECT 1
				FROM public.financial_requests fr
				WHERE fr.id = ast.request_id
					AND fr.status IN ('approved', 'rejected', 'completed')
			)
	) THEN
		RAISE EXCEPTION
			'F19.2 preflight failed: active stages exist on terminal requests. Preserve evidence and remediate explicitly.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT request_id, COUNT(*) AS active_count
			FROM public.approval_stage_tracking
			WHERE status = 'active'
			GROUP BY request_id
		) active_rows
		WHERE active_rows.active_count > 1
	) THEN
		RAISE EXCEPTION
			'F19.2 preflight failed: multiple active stages exist for at least one request.';
	END IF;
END;
$$;

ALTER TABLE public.approval_stage_tracking
	DROP CONSTRAINT IF EXISTS approval_stage_tracking_request_stage_unique;

ALTER TABLE public.approval_stage_tracking
	ADD CONSTRAINT approval_stage_tracking_request_revision_stage_unique
	UNIQUE (request_id, workflow_revision, stage_order);

ALTER TABLE public.approval_stage_tracking
	DROP CONSTRAINT IF EXISTS approval_stage_tracking_completion_check;

ALTER TABLE public.approval_stage_tracking
	ADD CONSTRAINT approval_stage_tracking_completion_check
	CHECK (
		completed_at IS NULL
		OR completed_at >= started_at
	),
	ADD CONSTRAINT approval_stage_tracking_queue_allowlist_check
	CHECK (public.f19_is_valid_queue_id(queue_id)),
	ADD CONSTRAINT approval_stage_tracking_status_completed_check
	CHECK (
		(
			status = 'active'
			AND completed_at IS NULL
		)
		OR (
			status IN ('completed', 'skipped', 'cancelled')
			AND completed_at IS NOT NULL
		)
	);

DROP INDEX IF EXISTS idx_approval_stage_tracking_request;
CREATE INDEX IF NOT EXISTS idx_approval_stage_tracking_request
	ON public.approval_stage_tracking (request_id, workflow_revision, stage_order);

CREATE UNIQUE INDEX IF NOT EXISTS approval_stage_tracking_single_active_per_request
	ON public.approval_stage_tracking (request_id)
	WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.f19_guard_stage_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF OLD.request_id IS DISTINCT FROM NEW.request_id
			 OR OLD.workflow_revision IS DISTINCT FROM NEW.workflow_revision
			 OR OLD.stage_order IS DISTINCT FROM NEW.stage_order
			 OR OLD.queue_id IS DISTINCT FROM NEW.queue_id
			 OR OLD.stage_name IS DISTINCT FROM NEW.stage_name
			 OR OLD.started_at IS DISTINCT FROM NEW.started_at
			 OR OLD.duration_hours IS DISTINCT FROM NEW.duration_hours
			 OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
		THEN
			RAISE EXCEPTION 'Approval stage history is immutable after creation.';
		END IF;

		IF OLD.status IN ('completed', 'skipped', 'cancelled')
			 AND (
				 NEW.status IS DISTINCT FROM OLD.status
				 OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
			 )
		THEN
			RAISE EXCEPTION 'Completed or cancelled stages are immutable.';
		END IF;

		IF OLD.status = 'active'
			 AND NEW.status = 'active'
			 AND NEW.completed_at IS DISTINCT FROM OLD.completed_at
		THEN
			RAISE EXCEPTION 'Active stages cannot set completed_at.';
		END IF;

		IF OLD.status = 'active'
			 AND NEW.status IN ('completed', 'skipped', 'cancelled')
			 AND NEW.completed_at IS NULL
		THEN
			NEW.completed_at := now();
		END IF;

		IF OLD.status <> 'active'
			 AND NEW.status = 'active'
		THEN
			RAISE EXCEPTION 'Terminal stages cannot return to active.';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.f19_guard_stage_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS f19_guard_stage_history ON public.approval_stage_tracking;
CREATE TRIGGER f19_guard_stage_history
BEFORE UPDATE ON public.approval_stage_tracking
FOR EACH ROW
EXECUTE FUNCTION public.f19_guard_stage_history();

-- ------------------------------------------------------------
-- Checkpoint 2: request field and routing protections
-- ------------------------------------------------------------

-- Bootstrap definition only. workflow_initialization_state does not exist
-- yet, so this version cannot see initialization claims. It is replaced in
-- Checkpoint 3 (below) by the authoritative definition that also protects
-- active, expired, and uncertain-delivery claims.
CREATE OR REPLACE FUNCTION public.f19_request_has_initialized_workflow(
	_request_id UUID,
	_workflow_triggered_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
	SELECT (
		_workflow_triggered_at IS NOT NULL
		OR EXISTS (
			SELECT 1
			FROM public.approval_stage_tracking ast
			WHERE ast.request_id = _request_id
		)
	);
$$;

-- Internal helper: only the SECURITY DEFINER guard trigger and amendment
-- function call it. It is not bound to auth.uid(), so it is not exposed to
-- API roles.
REVOKE ALL
ON FUNCTION public.f19_request_has_initialized_workflow(UUID, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.f19_guard_request_workflow_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	initialized BOOLEAN;
	allow_workflow_write BOOLEAN := COALESCE(current_setting('app.f19_trusted_workflow_write', true), '') = 'on';
	allow_amendment_write BOOLEAN := COALESCE(current_setting('app.f19_allow_amendment_write', true), '') = 'on';
BEGIN
	IF TG_OP <> 'UPDATE' THEN
		RETURN NEW;
	END IF;

	initialized := public.f19_request_has_initialized_workflow(OLD.id, OLD.workflow_triggered_at);

	IF initialized THEN
		IF (
			NEW.amount IS DISTINCT FROM OLD.amount
			OR NEW.funding_source IS DISTINCT FROM OLD.funding_source
			OR NEW.grant_number IS DISTINCT FROM OLD.grant_number
			OR NEW.principal_investigator IS DISTINCT FROM OLD.principal_investigator
			OR NEW.university_program IS DISTINCT FROM OLD.university_program
		)
		AND NOT allow_amendment_write
		THEN
			RAISE EXCEPTION
				'Protected request fields can only change through the amendment workflow.';
		END IF;

		IF (
			NEW.routed_to IS DISTINCT FROM OLD.routed_to
			OR (NEW.metadata #> '{routing}') IS DISTINCT FROM (OLD.metadata #> '{routing}')
		)
		AND NOT (allow_workflow_write OR allow_amendment_write)
		THEN
			RAISE EXCEPTION
				'Routing fields cannot be changed directly after workflow initialization.';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.f19_guard_request_workflow_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS f19_guard_request_workflow_fields ON public.financial_requests;
CREATE TRIGGER f19_guard_request_workflow_fields
BEFORE UPDATE ON public.financial_requests
FOR EACH ROW
EXECUTE FUNCTION public.f19_guard_request_workflow_fields();

-- Approval stages are now workflow-managed through SECURITY DEFINER functions.
DROP POLICY IF EXISTS "Reviewers can insert approval stage tracking" ON public.approval_stage_tracking;
DROP POLICY IF EXISTS "Reviewers can update approval stage tracking" ON public.approval_stage_tracking;
DROP POLICY IF EXISTS "Reviewers can delete approval stage tracking" ON public.approval_stage_tracking;

REVOKE INSERT, UPDATE, DELETE
ON public.approval_stage_tracking
FROM authenticated;

-- ------------------------------------------------------------
-- Checkpoint 3: atomic workflow init claim / completion
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_initialization_state (
	request_id UUID PRIMARY KEY
		REFERENCES public.financial_requests(id)
		ON DELETE CASCADE,
	status TEXT NOT NULL
		CHECK (status IN ('idle', 'claimed', 'completed')),
	request_revision INTEGER NOT NULL,
	claim_token UUID,
	claimed_by UUID,
	claimed_at TIMESTAMPTZ,
	claim_expires_at TIMESTAMPTZ,
	completed_at TIMESTAMPTZ,
	completion_mode TEXT,
	routing_snapshot JSONB NOT NULL,
	-- TRUE once a claim lease expired without completion and was taken over.
	-- The abandoned holder may already have delivered to Power Automate, so
	-- protected fields stay frozen even if a later attempt fails definitively.
	-- Cleared only by an amendment, which starts a new revision.
	delivery_uncertain BOOLEAN NOT NULL DEFAULT FALSE,
	last_error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT workflow_initialization_state_completion_mode_check
		CHECK (
			completion_mode IS NULL
			OR completion_mode IN ('power_automate', 'simulated', 'ambiguous_timeout', 'failed')
		)
);

CREATE INDEX IF NOT EXISTS idx_workflow_initialization_status
	ON public.workflow_initialization_state (status, updated_at DESC);

DROP TRIGGER IF EXISTS update_workflow_initialization_state_updated_at
	ON public.workflow_initialization_state;

CREATE TRIGGER update_workflow_initialization_state_updated_at
	BEFORE UPDATE ON public.workflow_initialization_state
	FOR EACH ROW
	EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.workflow_initialization_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own workflow initialization state"
	ON public.workflow_initialization_state;

CREATE POLICY "Users can view own workflow initialization state"
ON public.workflow_initialization_state
FOR SELECT
TO authenticated
USING (
	EXISTS (
		SELECT 1
		FROM public.financial_requests fr
		WHERE fr.id = workflow_initialization_state.request_id
			AND (
				fr.user_id = auth.uid()
				OR public.f16_is_admin_or_reviewer()
			)
	)
);

REVOKE INSERT, UPDATE, DELETE
ON public.workflow_initialization_state
FROM authenticated;

GRANT SELECT
ON public.workflow_initialization_state
TO authenticated;

-- Authoritative workflow-initialization detector (replaces the bootstrap
-- version from Checkpoint 2). A request is protected when any of these hold:
--   * workflow_triggered_at is set (initialization completed);
--   * approval stage history exists;
--   * initialization completed for the request;
--   * an initialization claim is held. This covers an unexpired claim for the
--     current revision AND an expired claim. Lease expiry only means the
--     holder stopped reporting, not that nothing was delivered, so an
--     expired claim stays protected until a new holder takes over;
--   * delivery_uncertain is set (a taken-over expired claim may have
--     delivered, even if the replacement attempt then failed definitively).
-- Read-only and touches no financial_requests rows, so calling it from the
-- BEFORE UPDATE guard cannot recurse.
CREATE OR REPLACE FUNCTION public.f19_request_has_initialized_workflow(
	_request_id UUID,
	_workflow_triggered_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
	SELECT (
		_workflow_triggered_at IS NOT NULL
		OR EXISTS (
			SELECT 1
			FROM public.workflow_initialization_state wis
			WHERE wis.request_id = _request_id
				AND (
					wis.status IN ('claimed', 'completed')
					OR wis.delivery_uncertain
				)
		)
		OR EXISTS (
			SELECT 1
			FROM public.approval_stage_tracking ast
			WHERE ast.request_id = _request_id
		)
	);
$$;

CREATE OR REPLACE FUNCTION public.f19_claim_workflow_initialization(
	_request_id UUID,
	_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	request_row RECORD;
	init_row RECORD;
	lease_seconds INTEGER := GREATEST(30, LEAST(COALESCE(_lease_seconds, 120), 900));
	new_claim_token UUID;
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
		RAISE EXCEPTION 'Not authorized to initialize workflow.';
	END IF;

	IF request_row.status NOT IN ('submitted'::public.request_status, 'under_review'::public.request_status) THEN
		RAISE EXCEPTION 'Request is not eligible for workflow initialization.';
	END IF;

	IF jsonb_typeof(request_row.metadata #> '{routing,approvalChain}') IS DISTINCT FROM 'array' THEN
		RAISE EXCEPTION 'Request routing metadata is missing or invalid.';
	END IF;

	SELECT *
	INTO init_row
	FROM public.workflow_initialization_state
	WHERE request_id = _request_id
	FOR UPDATE;

	IF NOT FOUND THEN
		INSERT INTO public.workflow_initialization_state (
			request_id,
			status,
			request_revision,
			routing_snapshot
		) VALUES (
			_request_id,
			'idle',
			request_row.workflow_revision,
			COALESCE(request_row.metadata #> '{routing}', '{}'::jsonb)
		);

		SELECT *
		INTO init_row
		FROM public.workflow_initialization_state
		WHERE request_id = _request_id
		FOR UPDATE;
	END IF;

	IF init_row.status = 'completed'
		 AND init_row.request_revision = request_row.workflow_revision THEN
		RETURN jsonb_build_object(
			'alreadyInitialized', TRUE,
			'claimGranted', FALSE,
			'claimToken', NULL,
			'requestRevision', request_row.workflow_revision,
			'routingSnapshot', init_row.routing_snapshot,
			'completionMode', init_row.completion_mode
		);
	END IF;

	IF init_row.status = 'claimed'
		 AND init_row.claim_expires_at IS NOT NULL
		 AND init_row.claim_expires_at > now()
	THEN
		RETURN jsonb_build_object(
			'alreadyInitialized', FALSE,
			'claimGranted', FALSE,
			'claimToken', NULL,
			'requestRevision', request_row.workflow_revision,
			'routingSnapshot', init_row.routing_snapshot,
			'claimExpiresAt', init_row.claim_expires_at
		);
	END IF;

	new_claim_token := gen_random_uuid();

	-- Reaching this point with status = 'claimed' means the previous lease
	-- expired without completion. That holder may have delivered, so record
	-- the uncertainty before handing out a new claim.
	UPDATE public.workflow_initialization_state
	SET
		delivery_uncertain = delivery_uncertain OR (init_row.status = 'claimed'),
		status = 'claimed',
		request_revision = request_row.workflow_revision,
		claim_token = new_claim_token,
		claimed_by = auth.uid(),
		claimed_at = now(),
		claim_expires_at = now() + make_interval(secs => lease_seconds),
		completed_at = NULL,
		completion_mode = NULL,
		routing_snapshot = COALESCE(request_row.metadata #> '{routing}', '{}'::jsonb),
		last_error = NULL
	WHERE request_id = _request_id;

	RETURN jsonb_build_object(
		'alreadyInitialized', FALSE,
		'claimGranted', TRUE,
		'claimToken', new_claim_token,
		'requestRevision', request_row.workflow_revision,
		'routingSnapshot', COALESCE(request_row.metadata #> '{routing}', '{}'::jsonb)
	);
END;
$$;

REVOKE ALL ON FUNCTION public.f19_claim_workflow_initialization(UUID, INTEGER)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.f19_claim_workflow_initialization(UUID, INTEGER)
TO authenticated;

CREATE OR REPLACE FUNCTION public.f19_complete_workflow_initialization(
	_request_id UUID,
	_claim_token UUID,
	_mode TEXT,
	_attempts INTEGER DEFAULT 0,
	_event_message TEXT DEFAULT NULL,
	_event_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	request_row RECORD;
	init_row RECORD;
	stage_id UUID;
	normalized_mode TEXT;
	event_type_value TEXT;
BEGIN
	IF auth.uid() IS NULL THEN
		RAISE EXCEPTION 'Authentication is required.';
	END IF;

	normalized_mode := lower(COALESCE(_mode, ''));
	IF normalized_mode NOT IN ('power_automate', 'simulated', 'ambiguous_timeout', 'failed') THEN
		RAISE EXCEPTION 'Invalid initialization completion mode.';
	END IF;

	SELECT *
	INTO request_row
	FROM public.financial_requests
	WHERE id = _request_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Financial request not found.';
	END IF;

	SELECT *
	INTO init_row
	FROM public.workflow_initialization_state
	WHERE request_id = _request_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Workflow initialization state does not exist.';
	END IF;

	IF init_row.status <> 'claimed' THEN
		RAISE EXCEPTION 'Workflow initialization is not currently claimed.';
	END IF;

	IF request_row.user_id <> auth.uid()
		 AND NOT EXISTS (
			 SELECT 1
			 FROM public.user_roles ur
			 WHERE ur.user_id = auth.uid()
				 AND ur.role IN ('admin'::public.app_role, 'reviewer'::public.app_role, 'leadership'::public.app_role)
		 ) THEN
		RAISE EXCEPTION 'Not authorized to complete workflow initialization.';
	END IF;

	IF init_row.claimed_by IS DISTINCT FROM auth.uid() THEN
		RAISE EXCEPTION 'Workflow initialization claim is owned by another caller.';
	END IF;

	IF init_row.claim_token IS DISTINCT FROM _claim_token THEN
		RAISE EXCEPTION 'Workflow initialization claim token is invalid.';
	END IF;

	IF init_row.claim_expires_at IS NULL OR init_row.claim_expires_at <= now() THEN
		RAISE EXCEPTION 'Workflow initialization claim has expired.';
	END IF;

	IF init_row.request_revision <> request_row.workflow_revision THEN
		RAISE EXCEPTION 'Request revision changed during workflow initialization.';
	END IF;

	IF init_row.routing_snapshot IS DISTINCT FROM (request_row.metadata #> '{routing}') THEN
		RAISE EXCEPTION 'Routing snapshot changed during workflow initialization.';
	END IF;

	IF normalized_mode = 'failed' THEN
		UPDATE public.workflow_initialization_state
		SET
			status = 'idle',
			completion_mode = 'failed',
			claim_token = NULL,
			claimed_by = NULL,
			claimed_at = NULL,
			claim_expires_at = NULL,
			completed_at = NULL,
			last_error = _event_message
		WHERE request_id = _request_id;

		event_type_value := 'workflow_failed';
	ELSE
		PERFORM set_config('app.f19_trusted_workflow_write', 'on', true);

		stage_id := public.f16_start_initial_approval_stage(_request_id);

		IF stage_id IS NULL THEN
			RAISE EXCEPTION 'Could not create initial approval stage.';
		END IF;

		UPDATE public.financial_requests
		SET workflow_triggered_at = COALESCE(workflow_triggered_at, now())
		WHERE id = _request_id;

		UPDATE public.workflow_initialization_state
		SET
			status = 'completed',
			completion_mode = normalized_mode,
			completed_at = now(),
			claim_token = NULL,
			claimed_by = NULL,
			claimed_at = NULL,
			claim_expires_at = NULL,
			last_error = NULL
		WHERE request_id = _request_id;

		event_type_value := 'workflow_initialized';
	END IF;

	INSERT INTO public.workflow_events (
		request_id,
		actor_user_id,
		event_type,
		message,
		metadata
	) VALUES (
		_request_id,
		auth.uid(),
		event_type_value,
		COALESCE(_event_message, CASE WHEN normalized_mode = 'failed' THEN 'Workflow initialization failed.' ELSE 'Workflow initialized.' END),
		COALESCE(_event_metadata, '{}'::jsonb)
			|| jsonb_build_object(
				'source', 'f19_workflow_initialization',
				'mode', normalized_mode,
				'attempts', GREATEST(COALESCE(_attempts, 0), 0),
				'requestRevision', request_row.workflow_revision,
				'initialStageId', stage_id
			)
	);

	RETURN jsonb_build_object(
		'requestId', _request_id,
		'mode', normalized_mode,
		'requestRevision', request_row.workflow_revision,
		'alreadyInitialized', FALSE,
		'initialStageId', stage_id,
		'failed', normalized_mode = 'failed'
	);
END;
$$;

REVOKE ALL ON FUNCTION public.f19_complete_workflow_initialization(
	UUID,
	UUID,
	TEXT,
	INTEGER,
	TEXT,
	JSONB
)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.f19_complete_workflow_initialization(
	UUID,
	UUID,
	TEXT,
	INTEGER,
	TEXT,
	JSONB
)
TO authenticated;

-- ------------------------------------------------------------
-- Checkpoint 4: amendment integrity + full chain restart
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.request_workflow_amendments (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	request_id UUID NOT NULL
		REFERENCES public.financial_requests(id)
		ON DELETE CASCADE,
	previous_revision INTEGER NOT NULL,
	new_revision INTEGER NOT NULL,
	reason TEXT,
	changed_fields TEXT[] NOT NULL,
	previous_values JSONB NOT NULL,
	new_values JSONB NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	amended_by UUID NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT request_workflow_amendments_revision_check
		CHECK (new_revision = previous_revision + 1)
);

CREATE INDEX IF NOT EXISTS idx_request_workflow_amendments_request
	ON public.request_workflow_amendments (request_id, created_at DESC);

ALTER TABLE public.request_workflow_amendments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view permitted workflow amendments"
	ON public.request_workflow_amendments;

CREATE POLICY "Users can view permitted workflow amendments"
ON public.request_workflow_amendments
FOR SELECT
TO authenticated
USING (
	EXISTS (
		SELECT 1
		FROM public.financial_requests fr
		WHERE fr.id = request_workflow_amendments.request_id
			AND (
				fr.user_id = auth.uid()
				OR public.f16_is_admin_or_reviewer()
			)
	)
);

REVOKE INSERT, UPDATE, DELETE
ON public.request_workflow_amendments
FROM authenticated;

GRANT SELECT
ON public.request_workflow_amendments
TO authenticated;

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
-- Keep F16 stage functions aligned with workflow revisions.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.f16_start_initial_approval_stage(
	_request_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$

DECLARE
	request_row RECORD;
	initial_queue TEXT;
	initial_stage_name TEXT;
	stage_duration NUMERIC(10,2);
	stage_id UUID;
	stage_started_at TIMESTAMPTZ := now();

BEGIN
	SELECT id, user_id, status, routed_to, metadata, workflow_revision
	INTO request_row
	FROM public.financial_requests
	WHERE id = _request_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Financial request not found.';
	END IF;

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

	IF request_row.status NOT IN ('submitted', 'under_review') THEN
		RAISE EXCEPTION 'Request is not eligible for SLA tracking.';
	END IF;

	IF jsonb_typeof(
		request_row.metadata #> '{routing,approvalChain}'
	) IS DISTINCT FROM 'array' THEN
		RAISE EXCEPTION 'Request approval chain is missing or invalid.';
	END IF;

	initial_queue :=
		request_row.metadata #>> '{routing,primaryQueue}';

	initial_stage_name :=
		request_row.metadata #>> '{routing,approvalChain,0,label}';

	IF initial_queue IS NULL
		 OR initial_stage_name IS NULL
		 OR request_row.metadata #>> '{routing,approvalChain,0,queue}'
				IS DISTINCT FROM initial_queue
		 OR request_row.metadata #>> '{routing,primaryLabel}'
				IS DISTINCT FROM initial_stage_name
		 OR NOT public.f19_is_valid_queue_id(initial_queue)
	THEN
		RAISE EXCEPTION 'Request routing and approval chain do not match.';
	END IF;

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

	PERFORM set_config('app.f19_trusted_workflow_write', 'on', true);

	INSERT INTO public.approval_stage_tracking (
		request_id,
		workflow_revision,
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
		request_row.workflow_revision,
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
	ON CONFLICT (request_id, workflow_revision, stage_order) DO NOTHING
	RETURNING id INTO stage_id;

	IF stage_id IS NULL THEN
		SELECT id
		INTO stage_id
		FROM public.approval_stage_tracking
		WHERE request_id = _request_id
			AND workflow_revision = request_row.workflow_revision
			AND stage_order = 1;
	END IF;

	RETURN stage_id;

END;
$function$;


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

		SELECT *
		INTO current_stage
		FROM public.approval_stage_tracking
		WHERE id = _stage_id
			AND request_id = _request_id
		FOR UPDATE;

		IF NOT FOUND THEN
				RAISE EXCEPTION 'Approval stage not found for this request.';
		END IF;

		IF current_stage.workflow_revision IS DISTINCT FROM request_row.workflow_revision THEN
				RAISE EXCEPTION 'Approval stage revision does not match the current request revision.';
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
								'workflowRevision', request_row.workflow_revision,
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

		next_step := approval_chain -> current_stage.stage_order;

		IF next_step IS NULL OR next_step = 'null'::JSONB THEN

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

				next_queue := next_step ->> 'queue';
				next_stage_name := next_step ->> 'label';

				next_stage_order := current_stage.stage_order + 1;

				IF next_queue IS NULL OR next_stage_name IS NULL OR NOT public.f19_is_valid_queue_id(next_queue) THEN
						RAISE EXCEPTION 'The next approval stage is missing required information.';
				END IF;

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

				INSERT INTO public.approval_stage_tracking (
						request_id,
						workflow_revision,
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
						request_row.workflow_revision,
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

				PERFORM set_config('app.f19_trusted_workflow_write', 'on', true);

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
						'workflowRevision', request_row.workflow_revision,
						'comment', cleaned_comment,
						'decidedAt', decision_timestamp,
						'finalStage', final_stage,
						'nextStageId', next_stage_id,
						'nextStageOrder', next_stage_order,
						'nextQueueId', next_queue
				)
		);

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

