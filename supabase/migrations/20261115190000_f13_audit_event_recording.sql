-- F13: Extend automated audit recording.
-- Capture administrative changes to request ownership and request numbers.
-- Snapshot the actor's roles at the time of the event.

CREATE OR REPLACE FUNCTION public.f5_tracked_fields()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'title',
    'requester_email',
    'department',
    'funding_source',
    'amount',
    'needed_by',
    'priority',
    'description',
    'grant_number',
    'principal_investigator',
    'university_program',
    'user_id',
    'request_number'
  ];
$$;

CREATE OR REPLACE FUNCTION public.f5_log_financial_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  actor_roles JSONB := '[]'::jsonb;
  old_json JSONB;
  new_json JSONB;
  field TEXT;
  changes JSONB := '{}'::jsonb;
BEGIN
  IF actor IS NOT NULL THEN
    SELECT COALESCE(
      jsonb_agg(role::TEXT ORDER BY role::TEXT),
      '[]'::jsonb
    )
    INTO actor_roles
    FROM public.user_roles
    WHERE user_id = actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.workflow_events (
      request_id, actor_user_id, event_type, message, metadata
    )
    VALUES (
      NEW.id,
      actor,
      'request_created',
      format(
        'Request %s created for $%s (%s funding).',
        NEW.request_number,
        to_char(NEW.amount, 'FM999,999,990.00'),
        NEW.funding_source
      ),
      jsonb_build_object(
        'source', 'db_trigger',
        'actorRoles', actor_roles,
        'requestNumber', NEW.request_number,
        'status', NEW.status,
        'amount', NEW.amount,
        'fundingSource', NEW.funding_source,
        'routedTo', NEW.routed_to
      )
    );

    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.workflow_events (
      request_id, actor_user_id, event_type, message, metadata
    )
    VALUES (
      NEW.id,
      actor,
      'status_changed',
      format('Status changed from %s to %s.', OLD.status, NEW.status),
      jsonb_build_object(
        'source', 'db_trigger',
        'actorRoles', actor_roles,
        'from', OLD.status,
        'to', NEW.status
      )
    );
  END IF;

  IF NEW.routed_to IS DISTINCT FROM OLD.routed_to THEN
    INSERT INTO public.workflow_events (
      request_id, actor_user_id, event_type, message, metadata
    )
    VALUES (
      NEW.id,
      actor,
      'routing_changed',
      format(
        'Routing changed from %s to %s.',
        coalesce(OLD.routed_to, 'none'),
        coalesce(NEW.routed_to, 'none')
      ),
      jsonb_build_object(
        'source', 'db_trigger',
        'actorRoles', actor_roles,
        'from', OLD.routed_to,
        'to', NEW.routed_to
      )
    );
  END IF;

  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  FOREACH field IN ARRAY public.f5_tracked_fields() LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      IF field = 'description' THEN
        changes := changes || jsonb_build_object(
          field,
          jsonb_build_object('changed', true)
        );
      ELSE
        changes := changes || jsonb_build_object(
          field,
          jsonb_build_object(
            'from', old_json -> field,
            'to', new_json -> field
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF changes <> '{}'::jsonb THEN
    INSERT INTO public.workflow_events (
      request_id, actor_user_id, event_type, message, metadata
    )
    VALUES (
      NEW.id,
      actor,
      'request_updated',
      format(
        'Updated %s.',
        array_to_string(
          ARRAY(SELECT jsonb_object_keys(changes)),
          ', '
        )
      ),
      jsonb_build_object(
        'source', 'db_trigger',
        'actorRoles', actor_roles,
        'changes', changes
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.f5_log_financial_request()
FROM PUBLIC, anon, authenticated;
