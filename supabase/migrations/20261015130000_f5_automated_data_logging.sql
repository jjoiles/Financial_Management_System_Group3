-- F5: Automated Data Logging
--
-- Every change to a financial request or its attachments is written to
-- workflow_events by the database itself. The app no longer has to remember
-- to log, and a change made outside the app (SQL editor, API call) is still
-- recorded.
--
-- Event types written here (metadata.source = 'db_trigger'):
--   request_created     a request was inserted
--   status_changed      status moved, e.g. submitted -> under_review
--   routing_changed     routed_to changed
--   request_updated     a tracked field changed (see f5_tracked_fields)
--   attachment_added    a file was linked to a request
--   attachment_removed  a file link was deleted
--
-- The functions are SECURITY DEFINER so they can write the log even though
-- RLS on workflow_events limits what users can insert directly. They only
-- ever insert; they never read user data back out.

CREATE INDEX IF NOT EXISTS workflow_events_request_created_idx
  ON public.workflow_events (request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_events_event_type_idx
  ON public.workflow_events (event_type);

-- Fields whose changes are logged. updated_at, metadata, and
-- workflow_triggered_at are system bookkeeping and are not logged as edits.
CREATE OR REPLACE FUNCTION public.f5_tracked_fields()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'title', 'requester_email', 'department', 'funding_source', 'amount',
    'needed_by', 'priority', 'description', 'grant_number',
    'principal_investigator', 'university_program'
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
  old_json JSONB;
  new_json JSONB;
  field TEXT;
  changes JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
    VALUES (
      NEW.id, actor, 'request_created',
      format('Request %s created for $%s (%s funding).',
             NEW.request_number, to_char(NEW.amount, 'FM999,999,990.00'), NEW.funding_source),
      jsonb_build_object(
        'source', 'db_trigger',
        'requestNumber', NEW.request_number,
        'status', NEW.status,
        'amount', NEW.amount,
        'fundingSource', NEW.funding_source,
        'routedTo', NEW.routed_to
      )
    );
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
    VALUES (
      NEW.id, actor, 'status_changed',
      format('Status changed from %s to %s.', OLD.status, NEW.status),
      jsonb_build_object('source', 'db_trigger', 'from', OLD.status, 'to', NEW.status)
    );
  END IF;

  IF NEW.routed_to IS DISTINCT FROM OLD.routed_to THEN
    INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
    VALUES (
      NEW.id, actor, 'routing_changed',
      format('Routing changed from %s to %s.',
             coalesce(OLD.routed_to, 'none'), coalesce(NEW.routed_to, 'none')),
      jsonb_build_object('source', 'db_trigger', 'from', OLD.routed_to, 'to', NEW.routed_to)
    );
  END IF;

  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  FOREACH field IN ARRAY public.f5_tracked_fields() LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      -- Long text is not copied into the log, only marked as changed.
      IF field = 'description' THEN
        changes := changes || jsonb_build_object(field, jsonb_build_object('changed', true));
      ELSE
        changes := changes || jsonb_build_object(
          field, jsonb_build_object('from', old_json -> field, 'to', new_json -> field));
      END IF;
    END IF;
  END LOOP;

  IF changes <> '{}'::jsonb THEN
    INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
    VALUES (
      NEW.id, actor, 'request_updated',
      format('Updated %s.', array_to_string(ARRAY(SELECT jsonb_object_keys(changes)), ', ')),
      jsonb_build_object('source', 'db_trigger', 'changes', changes)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f5_log_financial_request ON public.financial_requests;
CREATE TRIGGER f5_log_financial_request
AFTER INSERT OR UPDATE ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f5_log_financial_request();

CREATE OR REPLACE FUNCTION public.f5_log_request_attachment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.request_attachments;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;

  -- Skip when the parent request is being deleted (cascade); the request
  -- row and its events are going away too.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.financial_requests WHERE id = rec.request_id
  ) THEN
    RETURN OLD;
  END IF;

  INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
  VALUES (
    rec.request_id,
    auth.uid(),
    CASE WHEN TG_OP = 'DELETE' THEN 'attachment_removed' ELSE 'attachment_added' END,
    format('%s %s.', CASE WHEN TG_OP = 'DELETE' THEN 'Removed' ELSE 'Attached' END, rec.file_name),
    jsonb_build_object(
      'source', 'db_trigger',
      'attachmentId', rec.id,
      'fileName', rec.file_name,
      'fileSize', rec.file_size,
      'contentType', rec.content_type
    )
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f5_log_request_attachment ON public.request_attachments;
CREATE TRIGGER f5_log_request_attachment
AFTER INSERT OR DELETE ON public.request_attachments
FOR EACH ROW EXECUTE FUNCTION public.f5_log_request_attachment();

-- Trigger functions run via the trigger only; nobody should call them directly.
REVOKE ALL ON FUNCTION public.f5_log_financial_request() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f5_log_request_attachment() FROM PUBLIC, anon, authenticated;
