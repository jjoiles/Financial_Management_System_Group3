-- F19.2 regression checks: claim-window protection, amendment validation.
-- Run against local stack only:
--   npx supabase db reset --local --no-seed
--   docker exec -i <local-db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X < verification/f19_2_regression.sql
--   (`supabase db query` rejects multi-statement files.)

-- Claim-window protection (f19_request_has_initialized_workflow).
-- Each fixture has workflow_triggered_at NULL and no approval stages, so any
-- protection observed here must come from workflow_initialization_state.
DO $$
DECLARE
  u_owner UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  u_other UUID := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  routing JSONB := jsonb_build_object(
    'primaryQueue', 'department_budget',
    'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(
      jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
    ),
    'flags', jsonb_build_array(),
    'rulesVersion', 'test-fixture'
  );
  req_id UUID;
  req_plain_fail UUID;
  claim_1 JSONB;
  claim_2 JSONB;
  claim_3 JSONB;
  token_1 UUID;
  token_2 UUID;
  amend_result JSONB;
BEGIN
  INSERT INTO auth.users (id) VALUES (u_owner) ON CONFLICT (id) DO NOTHING;
  INSERT INTO auth.users (id) VALUES (u_other) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (u_other, 'reviewer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  -- The detector is an internal helper and must not be callable by API roles.
  IF has_function_privilege('authenticated', 'public.f19_request_has_initialized_workflow(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.f19_request_has_initialized_workflow(uuid, timestamptz)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Expected f19_request_has_initialized_workflow to be revoked from API roles.';
  END IF;

  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, routed_to, metadata
  ) VALUES (
    u_owner, 'F19.2 claim-window fixture', 'owner@howard.edu', 'Finance',
    'department', 1500, current_date + 30, 'medium',
    'Fixture request for claim-window guard checks', 'submitted',
    'Department Budget Reviewer', jsonb_build_object('routing', routing)
  )
  RETURNING id INTO req_id;

  -- Baseline: before any claim the request is NOT protected, and a
  -- protected-field update succeeds. This proves the later rejection comes
  -- from the claim state, not from another guard.
  IF public.f19_request_has_initialized_workflow(req_id, NULL) THEN
    RAISE EXCEPTION 'Expected unclaimed request to be unprotected.';
  END IF;
  UPDATE public.financial_requests SET amount = amount + 1 WHERE id = req_id;

  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);

  claim_1 := public.f19_claim_workflow_initialization(req_id, 300);
  IF COALESCE((claim_1 ->> 'claimGranted')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Expected first claim to be granted.';
  END IF;
  token_1 := (claim_1 ->> 'claimToken')::UUID;

  IF EXISTS (SELECT 1 FROM public.approval_stage_tracking WHERE request_id = req_id)
     OR (SELECT workflow_triggered_at FROM public.financial_requests WHERE id = req_id) IS NOT NULL
  THEN
    RAISE EXCEPTION 'Fixture invalid: claim-window test must have no stages and no workflow_triggered_at.';
  END IF;

  IF NOT public.f19_request_has_initialized_workflow(req_id, NULL) THEN
    RAISE EXCEPTION 'Expected active claim to be recognized as protected.';
  END IF;

  BEGIN
    UPDATE public.financial_requests
    SET amount = amount + 1
    WHERE id = req_id;
    RAISE EXCEPTION 'Expected protected-field update rejection during active claim window.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('Protected request fields can only change through the amendment workflow' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Unrelated metadata updates must remain allowed during the claim.
  UPDATE public.financial_requests
  SET metadata = jsonb_set(metadata, '{attachments}', '[{"name":"quote.pdf"}]'::jsonb, true)
  WHERE id = req_id;
  IF (SELECT metadata #>> '{attachments,0,name}' FROM public.financial_requests WHERE id = req_id)
     IS DISTINCT FROM 'quote.pdf'
  THEN
    RAISE EXCEPTION 'Expected attachment metadata update to persist during active claim.';
  END IF;

  -- Same user cannot replace an active claim.
  claim_2 := public.f19_claim_workflow_initialization(req_id, 300);
  IF COALESCE((claim_2 ->> 'claimGranted')::BOOLEAN, false) IS TRUE THEN
    RAISE EXCEPTION 'Expected same-user second claim to be blocked while claim is active.';
  END IF;

  -- Different user also cannot replace an active claim.
  PERFORM set_config('request.jwt.claim.sub', u_other::TEXT, false);
  claim_3 := public.f19_claim_workflow_initialization(req_id, 300);
  IF COALESCE((claim_3 ->> 'claimGranted')::BOOLEAN, false) IS TRUE THEN
    RAISE EXCEPTION 'Expected different-user claim to be blocked while claim is active.';
  END IF;

  -- Expire the claim. An expired claim stays protected: the holder may
  -- already have delivered to Power Automate.
  UPDATE public.workflow_initialization_state
  SET claim_expires_at = now() - interval '1 second'
  WHERE request_id = req_id;

  IF NOT public.f19_request_has_initialized_workflow(req_id, NULL) THEN
    RAISE EXCEPTION 'Expected expired claim to remain protected.';
  END IF;
  BEGIN
    UPDATE public.financial_requests SET amount = amount + 1 WHERE id = req_id;
    RAISE EXCEPTION 'Expected protected-field update rejection for expired claim.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('Protected request fields can only change through the amendment workflow' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Expired-claim recovery: a new caller can take over.
  claim_3 := public.f19_claim_workflow_initialization(req_id, 300);
  IF COALESCE((claim_3 ->> 'claimGranted')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Expected claim reclaim after lease expiration.';
  END IF;

  token_2 := (claim_3 ->> 'claimToken')::UUID;
  IF token_2 IS NULL OR token_2 = token_1 THEN
    RAISE EXCEPTION 'Expected a new claim token after reclaim.';
  END IF;

  IF NOT (SELECT delivery_uncertain FROM public.workflow_initialization_state WHERE request_id = req_id) THEN
    RAISE EXCEPTION 'Expected takeover of an expired claim to mark delivery_uncertain.';
  END IF;

  -- Stale token cannot complete after reclaim.
  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);
  BEGIN
    PERFORM public.f19_complete_workflow_initialization(
      req_id, token_1, 'failed', 1, 'stale token test', '{}'::jsonb
    );
    RAISE EXCEPTION 'Expected stale token completion to fail.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('claim token is invalid' IN SQLERRM) = 0
         AND POSITION('owned by another caller' IN SQLERRM) = 0
      THEN
        RAISE;
      END IF;
  END;

  -- The new holder gets a definite rejection. Because the expired holder may
  -- have delivered, protected fields must stay frozen even though the state
  -- returns to idle.
  PERFORM set_config('request.jwt.claim.sub', u_other::TEXT, false);
  PERFORM public.f19_complete_workflow_initialization(
    req_id, token_2, 'failed', 1, 'definite 400 after takeover', '{}'::jsonb
  );
  IF (SELECT status FROM public.workflow_initialization_state WHERE request_id = req_id) <> 'idle' THEN
    RAISE EXCEPTION 'Expected failed completion to return state to idle.';
  END IF;
  IF NOT public.f19_request_has_initialized_workflow(req_id, NULL) THEN
    RAISE EXCEPTION 'Expected delivery_uncertain to keep request protected after takeover failure.';
  END IF;
  BEGIN
    UPDATE public.financial_requests SET amount = amount + 1 WHERE id = req_id;
    RAISE EXCEPTION 'Expected protected-field update rejection after takeover failure.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('Protected request fields can only change through the amendment workflow' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Contrast: a definite failure with no expired/taken-over claim does not
  -- freeze the request (nothing could have been delivered).
  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, routed_to, metadata
  ) VALUES (
    u_owner, 'F19.2 plain failure fixture', 'owner@howard.edu', 'Finance',
    'department', 900, current_date + 30, 'medium',
    'Fixture for definite failure without takeover', 'submitted',
    'Department Budget Reviewer', jsonb_build_object('routing', routing)
  )
  RETURNING id INTO req_plain_fail;

  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);
  claim_1 := public.f19_claim_workflow_initialization(req_plain_fail, 300);
  PERFORM public.f19_complete_workflow_initialization(
    req_plain_fail, (claim_1 ->> 'claimToken')::UUID, 'failed', 1, 'definite 400', '{}'::jsonb
  );
  IF public.f19_request_has_initialized_workflow(req_plain_fail, NULL) THEN
    RAISE EXCEPTION 'Expected plain definite failure to leave request unprotected.';
  END IF;
  UPDATE public.financial_requests SET amount = amount + 1 WHERE id = req_plain_fail;

  -- Amendment remains available for the uncertain-delivery request and starts
  -- a clean revision. Runs last: it sets transaction-local trusted-write flags.
  amend_result := public.f19_amend_request_workflow(
    req_id, 2500, 'department', NULL, NULL, NULL,
    'Department Budget Reviewer', routing, 'amend after uncertain delivery'
  );
  IF (amend_result ->> 'newRevision')::INTEGER <> 2 THEN
    RAISE EXCEPTION 'Expected amendment to advance revision after uncertain delivery.';
  END IF;
  IF (SELECT delivery_uncertain FROM public.workflow_initialization_state WHERE request_id = req_id) THEN
    RAISE EXCEPTION 'Expected amendment to clear delivery_uncertain for the new revision.';
  END IF;
END;
$$;

DO $$
DECLARE
  u_owner UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  req_invalid UUID;
  req_valid UUID;
  revision_before INTEGER;
  amendment_count_before INTEGER;
  active_stage_before INTEGER;
  valid_result JSONB;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);

  INSERT INTO public.financial_requests (
    user_id,
    title,
    requester_email,
    department,
    funding_source,
    amount,
    needed_by,
    priority,
    description,
    status,
    workflow_triggered_at,
    routed_to,
    metadata
  ) VALUES (
    u_owner,
    'F19.2 amendment invalid fixture',
    'owner@howard.edu',
    'Finance',
    'department',
    1200,
    current_date + 30,
    'medium',
    'Fixture request for invalid amendment routing checks',
    'under_review',
    now(),
    'Department Budget Reviewer',
    jsonb_build_object(
      'routing', jsonb_build_object(
        'primaryQueue', 'department_budget',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
        ),
        'flags', jsonb_build_array(),
        'rulesVersion', 'test-fixture'
      )
    )
  )
  RETURNING id INTO req_invalid;

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
  ) VALUES (
    req_invalid,
    1,
    1,
    'department_budget',
    'Department Budget Reviewer',
    now(),
    72,
    now() + interval '72 hour',
    'active'
  );

  SELECT workflow_revision INTO revision_before
  FROM public.financial_requests
  WHERE id = req_invalid;

  SELECT COUNT(*)::INTEGER INTO amendment_count_before
  FROM public.request_workflow_amendments
  WHERE request_id = req_invalid;

  SELECT COUNT(*)::INTEGER INTO active_stage_before
  FROM public.approval_stage_tracking
  WHERE request_id = req_invalid
    AND status = 'active';

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_invalid,
      1800,
      'department',
      NULL,
      NULL,
      NULL,
      'Department Budget Reviewer',
      jsonb_build_object(
        'primaryQueue', 'department_budget',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer'),
          jsonb_build_object('step', 2, 'queue', 'fake_queue', 'label', 'Fake Queue')
        )
      ),
      'invalid queue in chain'
    );
    RAISE EXCEPTION 'Expected amendment rejection for invalid approvalChain queue.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('unsupported queue' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_invalid,
      1800,
      'department',
      NULL,
      NULL,
      NULL,
      'Department Budget Reviewer',
      jsonb_build_object(
        'primaryQueue', 'fake_queue',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
        )
      ),
      'invalid primary queue'
    );
    RAISE EXCEPTION 'Expected amendment rejection for invalid primary queue.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('routing snapshot is invalid' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_invalid,
      1800,
      'department',
      NULL,
      NULL,
      NULL,
      'Dean''s Office',
      jsonb_build_object(
        'primaryQueue', 'department_budget',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
        )
      ),
      'routed_to mismatch'
    );
    RAISE EXCEPTION 'Expected amendment rejection for routed_to mismatch.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('routed_to must match routing.primaryLabel' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_invalid,
      1800,
      'department',
      NULL,
      NULL,
      NULL,
      'Department Budget Reviewer',
      jsonb_build_object(
        'primaryQueue', 'department_budget',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
        )
      ),
      'missing primaryLabel'
    );
    RAISE EXCEPTION 'Expected amendment rejection for missing required routing field.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('routing snapshot is invalid' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_invalid,
      1800,
      'department',
      NULL,
      NULL,
      NULL,
      'Department Budget Reviewer',
      jsonb_build_object(
        'primaryQueue', 'department_budget',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array('"not-an-object"'::jsonb)
      ),
      'malformed chain item'
    );
    RAISE EXCEPTION 'Expected amendment rejection for malformed approvalChain.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('is not an object' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  IF (SELECT workflow_revision FROM public.financial_requests WHERE id = req_invalid) <> revision_before THEN
    RAISE EXCEPTION 'Invalid amendment changed workflow_revision.';
  END IF;

  IF (SELECT COUNT(*)::INTEGER FROM public.request_workflow_amendments WHERE request_id = req_invalid) <> amendment_count_before THEN
    RAISE EXCEPTION 'Invalid amendment wrote amendment history.';
  END IF;

  IF (SELECT COUNT(*)::INTEGER FROM public.approval_stage_tracking WHERE request_id = req_invalid AND status = 'active') <> active_stage_before THEN
    RAISE EXCEPTION 'Invalid amendment changed active stage state.';
  END IF;

  INSERT INTO public.financial_requests (
    user_id,
    title,
    requester_email,
    department,
    funding_source,
    amount,
    needed_by,
    priority,
    description,
    status,
    workflow_triggered_at,
    routed_to,
    metadata
  ) VALUES (
    u_owner,
    'F19.2 amendment valid fixture',
    'owner@howard.edu',
    'Finance',
    'department',
    1300,
    current_date + 30,
    'medium',
    'Fixture request for valid amendment routing checks',
    'under_review',
    now(),
    'Department Budget Reviewer',
    jsonb_build_object(
      'routing', jsonb_build_object(
        'primaryQueue', 'department_budget',
        'primaryLabel', 'Department Budget Reviewer',
        'approvalChain', jsonb_build_array(
          jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
        ),
        'flags', jsonb_build_array(),
        'rulesVersion', 'test-fixture'
      )
    )
  )
  RETURNING id INTO req_valid;

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
  ) VALUES (
    req_valid,
    1,
    1,
    'department_budget',
    'Department Budget Reviewer',
    now(),
    72,
    now() + interval '72 hour',
    'active'
  );

  valid_result := public.f19_amend_request_workflow(
    req_valid,
    2400,
    'department',
    NULL,
    NULL,
    NULL,
    'Department Budget Reviewer',
    jsonb_build_object(
      'primaryQueue', 'department_budget',
      'primaryLabel', 'Department Budget Reviewer',
      'approvalChain', jsonb_build_array(
        jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer'),
        jsonb_build_object('step', 2, 'queue', 'dean_office', 'label', 'Dean''s Office')
      ),
      'flags', jsonb_build_array('multi_level'),
      'rulesVersion', 'test-fixture'
    ),
    'valid amendment'
  );

  IF (valid_result ->> 'newRevision')::INTEGER <> 2 THEN
    RAISE EXCEPTION 'Expected valid amendment to increment workflow revision to 2.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.approval_stage_tracking ast
    WHERE ast.request_id = req_valid
      AND ast.workflow_revision = 2
      AND ast.stage_order = 1
      AND ast.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Expected valid amendment to create initial stage for new revision.';
  END IF;
END;
$$;

-- Amendment change detection: routing-only, no-op, and routed_to-only.
-- Each case is its own DO block (own transaction) because amendments set
-- transaction-local trusted-write flags.

-- Test 1: routing-only amendment (routing snapshot + matching routed_to change;
-- all five financial/request fields unchanged).
DO $$
DECLARE
  u_owner UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  old_routing JSONB := jsonb_build_object(
    'primaryQueue', 'department_budget',
    'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(
      jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
    ),
    'flags', jsonb_build_array(),
    'rulesVersion', 'test-fixture'
  );
  new_routing JSONB := jsonb_build_object(
    'primaryQueue', 'dean_office',
    'primaryLabel', 'Dean''s Office',
    'approvalChain', jsonb_build_array(
      jsonb_build_object('step', 1, 'queue', 'dean_office', 'label', 'Dean''s Office'),
      jsonb_build_object('step', 2, 'queue', 'cfo_office', 'label', 'CFO Office')
    ),
    'flags', jsonb_build_array('rerouted'),
    'rulesVersion', 'test-fixture'
  );
  req_id UUID;
  old_stage_id UUID;
  result JSONB;
  amend RECORD;
  req RECORD;
  wis RECORD;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);

  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, workflow_triggered_at,
    routed_to, metadata
  ) VALUES (
    u_owner, 'F19.2 routing-only amendment fixture', 'owner@howard.edu', 'Finance',
    'department', 1300, current_date + 30, 'medium',
    'Fixture for routing-only amendment', 'under_review', now(),
    'Department Budget Reviewer', jsonb_build_object('routing', old_routing)
  )
  RETURNING id INTO req_id;

  INSERT INTO public.approval_stage_tracking (
    request_id, workflow_revision, stage_order, queue_id, stage_name,
    started_at, duration_hours, deadline_at, status
  ) VALUES (
    req_id, 1, 1, 'department_budget', 'Department Budget Reviewer',
    now(), 72, now() + interval '72 hour', 'active'
  )
  RETURNING id INTO old_stage_id;

  result := public.f19_amend_request_workflow(
    req_id, 1300, 'department', NULL, NULL, NULL,
    'Dean''s Office', new_routing, 'routing-only amendment'
  );

  IF (result ->> 'previousRevision')::INTEGER <> 1 OR (result ->> 'newRevision')::INTEGER <> 2 THEN
    RAISE EXCEPTION 'Routing-only amendment: expected revision 1 -> 2, got %.', result;
  END IF;

  SELECT * INTO req FROM public.financial_requests WHERE id = req_id;
  IF req.workflow_revision <> 2 THEN
    RAISE EXCEPTION 'Routing-only amendment: expected workflow_revision 2, got %.', req.workflow_revision;
  END IF;
  IF req.amount <> 1300 OR req.funding_source <> 'department'
     OR req.grant_number IS NOT NULL OR req.principal_investigator IS NOT NULL
     OR req.university_program IS NOT NULL
  THEN
    RAISE EXCEPTION 'Routing-only amendment changed financial/request fields.';
  END IF;
  IF req.routed_to <> 'Dean''s Office' OR (req.metadata -> 'routing') IS DISTINCT FROM new_routing THEN
    RAISE EXCEPTION 'Routing-only amendment did not persist new routing.';
  END IF;

  IF (SELECT COUNT(*) FROM public.request_workflow_amendments WHERE request_id = req_id) <> 1 THEN
    RAISE EXCEPTION 'Routing-only amendment: expected exactly one amendment record.';
  END IF;
  SELECT * INTO amend FROM public.request_workflow_amendments WHERE request_id = req_id;
  IF amend.changed_fields IS DISTINCT FROM ARRAY['routed_to', 'metadata.routing']::TEXT[] THEN
    RAISE EXCEPTION 'Routing-only amendment: unexpected changed_fields %.', amend.changed_fields;
  END IF;
  IF amend.previous_revision <> 1 OR amend.new_revision <> 2 THEN
    RAISE EXCEPTION 'Routing-only amendment: wrong revisions in amendment record.';
  END IF;
  IF (amend.previous_values -> 'routing') IS DISTINCT FROM old_routing
     OR (amend.previous_values ->> 'routed_to') IS DISTINCT FROM 'Department Budget Reviewer'
     OR (amend.new_values -> 'routing') IS DISTINCT FROM new_routing
     OR (amend.new_values ->> 'routed_to') IS DISTINCT FROM 'Dean''s Office'
  THEN
    RAISE EXCEPTION 'Routing-only amendment: before/after routing snapshots are wrong.';
  END IF;
  IF (amend.previous_values ->> 'amount')::NUMERIC <> 1300 OR (amend.new_values ->> 'amount')::NUMERIC <> 1300 THEN
    RAISE EXCEPTION 'Routing-only amendment: amount snapshots are wrong.';
  END IF;

  IF (SELECT status FROM public.approval_stage_tracking WHERE id = old_stage_id) <> 'cancelled' THEN
    RAISE EXCEPTION 'Routing-only amendment: previous active stage was not cancelled.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_stage_tracking
    WHERE request_id = req_id AND workflow_revision = 2 AND stage_order = 1
      AND status = 'active' AND queue_id = 'dean_office' AND stage_name = 'Dean''s Office'
  ) THEN
    RAISE EXCEPTION 'Routing-only amendment: new revision did not restart at the new stage 1.';
  END IF;
  IF (SELECT COUNT(*) FROM public.approval_stage_tracking WHERE request_id = req_id AND status = 'active') <> 1 THEN
    RAISE EXCEPTION 'Routing-only amendment: expected exactly one active stage.';
  END IF;

  SELECT * INTO wis FROM public.workflow_initialization_state WHERE request_id = req_id;
  IF wis.status <> 'completed' OR wis.request_revision <> 2
     OR wis.completion_mode IS DISTINCT FROM 'simulated'
     OR wis.routing_snapshot IS DISTINCT FROM new_routing
     OR wis.claim_token IS NOT NULL OR wis.delivery_uncertain
  THEN
    RAISE EXCEPTION 'Routing-only amendment: unexpected initialization state %.', row_to_json(wis);
  END IF;
END;
$$;

-- Test 2: no-op amendment (all protected fields and routing unchanged) is
-- rejected with no side effects.
DO $$
DECLARE
  u_owner UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  routing JSONB := jsonb_build_object(
    'primaryQueue', 'department_budget',
    'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(
      jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
    ),
    'flags', jsonb_build_array(),
    'rulesVersion', 'test-fixture'
  );
  req_id UUID;
  stage_id UUID;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);

  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, workflow_triggered_at,
    routed_to, metadata
  ) VALUES (
    u_owner, 'F19.2 no-op amendment fixture', 'owner@howard.edu', 'Finance',
    'department', 1300, current_date + 30, 'medium',
    'Fixture for no-op amendment', 'under_review', now(),
    'Department Budget Reviewer', jsonb_build_object('routing', routing)
  )
  RETURNING id INTO req_id;

  INSERT INTO public.approval_stage_tracking (
    request_id, workflow_revision, stage_order, queue_id, stage_name,
    started_at, duration_hours, deadline_at, status
  ) VALUES (
    req_id, 1, 1, 'department_budget', 'Department Budget Reviewer',
    now(), 72, now() + interval '72 hour', 'active'
  )
  RETURNING id INTO stage_id;

  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_id, 1300, 'department', NULL, NULL, NULL,
      'Department Budget Reviewer', routing, 'no-op'
    );
    RAISE EXCEPTION 'Expected no-op amendment to be rejected.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('Amendment does not change protected fields' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  IF (SELECT workflow_revision FROM public.financial_requests WHERE id = req_id) <> 1 THEN
    RAISE EXCEPTION 'No-op amendment changed workflow_revision.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.request_workflow_amendments WHERE request_id = req_id) THEN
    RAISE EXCEPTION 'No-op amendment wrote an amendment record.';
  END IF;
  IF (SELECT COUNT(*) FROM public.approval_stage_tracking WHERE request_id = req_id) <> 1
     OR (SELECT status FROM public.approval_stage_tracking WHERE id = stage_id) <> 'active'
  THEN
    RAISE EXCEPTION 'No-op amendment modified approval stages.';
  END IF;
END;
$$;

-- Test 3: only routed_to changes. Validation requires _routed_to to equal
-- _routing.primaryLabel, so with an unchanged routing snapshot this is only
-- possible when the stored routed_to has drifted from the stored
-- routing.primaryLabel. The amendment repairs that drift; validation is not
-- relaxed.
DO $$
DECLARE
  u_owner UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  routing JSONB := jsonb_build_object(
    'primaryQueue', 'department_budget',
    'primaryLabel', 'Department Budget Reviewer',
    'approvalChain', jsonb_build_array(
      jsonb_build_object('step', 1, 'queue', 'department_budget', 'label', 'Department Budget Reviewer')
    ),
    'flags', jsonb_build_array(),
    'rulesVersion', 'test-fixture'
  );
  req_id UUID;
  amend RECORD;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u_owner::TEXT, false);

  INSERT INTO public.financial_requests (
    user_id, title, requester_email, department, funding_source, amount,
    needed_by, priority, description, status, workflow_triggered_at,
    routed_to, metadata
  ) VALUES (
    u_owner, 'F19.2 routed_to-only amendment fixture', 'owner@howard.edu', 'Finance',
    'department', 1300, current_date + 30, 'medium',
    'Fixture for routed_to-only amendment', 'under_review', now(),
    'Legacy Reviewer Label', jsonb_build_object('routing', routing)
  )
  RETURNING id INTO req_id;

  INSERT INTO public.approval_stage_tracking (
    request_id, workflow_revision, stage_order, queue_id, stage_name,
    started_at, duration_hours, deadline_at, status
  ) VALUES (
    req_id, 1, 1, 'department_budget', 'Department Budget Reviewer',
    now(), 72, now() + interval '72 hour', 'active'
  );

  -- A routed_to that disagrees with routing.primaryLabel is still rejected.
  BEGIN
    PERFORM public.f19_amend_request_workflow(
      req_id, 1300, 'department', NULL, NULL, NULL,
      'Some Other Label', routing, 'inconsistent routed_to'
    );
    RAISE EXCEPTION 'Expected inconsistent routed_to amendment to be rejected.';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('routed_to must match routing.primaryLabel' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  PERFORM public.f19_amend_request_workflow(
    req_id, 1300, 'department', NULL, NULL, NULL,
    'Department Budget Reviewer', routing, 'repair routed_to drift'
  );

  SELECT * INTO amend FROM public.request_workflow_amendments WHERE request_id = req_id;
  IF amend.changed_fields IS DISTINCT FROM ARRAY['routed_to']::TEXT[] THEN
    RAISE EXCEPTION 'routed_to-only amendment: unexpected changed_fields %.', amend.changed_fields;
  END IF;
  IF (amend.previous_values ->> 'routed_to') IS DISTINCT FROM 'Legacy Reviewer Label'
     OR (amend.new_values ->> 'routed_to') IS DISTINCT FROM 'Department Budget Reviewer'
  THEN
    RAISE EXCEPTION 'routed_to-only amendment: routed_to snapshots are wrong.';
  END IF;
  IF (SELECT workflow_revision FROM public.financial_requests WHERE id = req_id) <> 2 THEN
    RAISE EXCEPTION 'routed_to-only amendment: expected workflow_revision 2.';
  END IF;
END;
$$;
