-- REVIEW ONLY / NOT APPLIED. Separate explicit approval required.
-- Outside migration runners. No account/role/backfill/shared-helper changes.
-- Apply atomically through the approved migration workflow, not this file directly.

CREATE FUNCTION public.f10_reviewer_access()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND (auth.jwt() ->> 'aal') = 'aal2'
    AND EXISTS (SELECT 1 FROM public.user_roles u
      WHERE u.user_id = auth.uid() AND u.role IN ('reviewer', 'admin')), false);
$$;
REVOKE ALL ON FUNCTION public.f10_reviewer_access() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.f10_reviewer_access() TO authenticated;

CREATE TABLE public.reviewer_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  request_id uuid NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  request_number text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('submitted', 'under_review')),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'delivered', 'unassigned', 'failed', 'superseded', 'inactive')),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.reviewer_notification_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reviewer_notification_events TO authenticated;
GRANT ALL ON public.reviewer_notification_events TO service_role;
ALTER TABLE public.reviewer_notification_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "F10 AAL2 admins read delivery outcomes" ON public.reviewer_notification_events
  FOR SELECT TO authenticated USING (
    public.f10_reviewer_access() AND public.has_role(auth.uid(), 'admin'::public.app_role)
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );
CREATE INDEX reviewer_events_request_order_idx ON public.reviewer_notification_events (request_id, event_order DESC);
-- Service generation requires sequence rights; no browser sequence grants.
REVOKE ALL ON SEQUENCE public.reviewer_notification_events_event_order_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.reviewer_notification_events_event_order_seq TO service_role;

CREATE TABLE public.reviewer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.reviewer_notification_events(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  request_number text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('submitted', 'under_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (event_id, recipient_user_id)
);
REVOKE ALL ON public.reviewer_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reviewer_notifications TO authenticated;
GRANT UPDATE (read_at) ON public.reviewer_notifications TO authenticated;
GRANT ALL ON public.reviewer_notifications TO service_role;
ALTER TABLE public.reviewer_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "F10 AAL2 reviewers read own alerts" ON public.reviewer_notifications
  FOR SELECT TO authenticated USING (
    recipient_user_id = auth.uid() AND public.f10_reviewer_access()
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );
CREATE POLICY "F10 AAL2 reviewers change own read state" ON public.reviewer_notifications
  FOR UPDATE TO authenticated USING (
    recipient_user_id = auth.uid() AND public.f10_reviewer_access()
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  ) WITH CHECK (
    recipient_user_id = auth.uid() AND public.f10_reviewer_access()
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );
CREATE INDEX reviewer_notifications_recipient_created_idx ON public.reviewer_notifications (recipient_user_id, created_at DESC, id);
CREATE INDEX reviewer_notifications_request_idx ON public.reviewer_notifications (request_id);

-- Trusted definer owner must have generation rights and bypass RLS, with no
-- browser membership in that owner role. Objects/functions are schema-qualified;
-- pg_catalog-first search_path prevents public object shadowing. Owner/grants
-- must be inspected in the isolated deployment before enabling the trigger.
CREATE FUNCTION public.f10_deliver_reviewer_event(_event_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  attention public.reviewer_notification_events%ROWTYPE;
  target_request uuid;
  current_status public.request_status;
  recipients integer;
  error_code text;
BEGIN
  SELECT e.request_id INTO target_request FROM public.reviewer_notification_events e WHERE e.id = _event_id;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  -- Always request -> event lock order, matching the request trigger; avoids
  -- event -> request deadlocks and serializes new attention with old retries.
  SELECT r.status INTO current_status FROM public.financial_requests r WHERE r.id = target_request FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  SELECT * INTO attention FROM public.reviewer_notification_events e WHERE e.id = _event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF attention.outcome IN ('delivered', 'superseded', 'inactive') THEN RETURN attention.outcome; END IF;
  IF EXISTS (SELECT 1 FROM public.reviewer_notification_events e
    WHERE e.request_id = target_request AND e.event_order > attention.event_order) THEN
    UPDATE public.reviewer_notification_events SET outcome = 'superseded' WHERE id = attention.id;
    RETURN 'superseded';
  END IF;
  IF current_status NOT IN ('submitted', 'under_review') THEN
    UPDATE public.reviewer_notification_events SET outcome = 'inactive' WHERE id = attention.id;
    RETURN 'inactive';
  END IF;
  BEGIN
    INSERT INTO public.reviewer_notifications (event_id, request_id, recipient_user_id, request_number, reason)
    SELECT attention.id, attention.request_id, u.user_id, attention.request_number, attention.reason
    FROM (SELECT DISTINCT user_id FROM public.user_roles WHERE role IN ('reviewer', 'admin')) u
    -- Today exact reviewers/admins have global request SELECT under existing
    -- RLS. Future queue-scoped access requires revising recipient selection.
    ON CONFLICT (event_id, recipient_user_id) DO NOTHING;
    SELECT count(*) INTO recipients FROM public.reviewer_notifications n WHERE n.event_id = attention.id;
    UPDATE public.reviewer_notification_events SET outcome = CASE WHEN recipients = 0 THEN 'unassigned' ELSE 'delivered' END,
      recipient_count = recipients, failure_code = NULL WHERE id = attention.id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_code = RETURNED_SQLSTATE;
    UPDATE public.reviewer_notification_events SET outcome = 'failed', failure_code = error_code WHERE id = attention.id;
    RAISE WARNING 'F10 delivery failed (SQLSTATE %).', error_code;
    RETURN 'failed';
  END;
  RETURN CASE WHEN recipients = 0 THEN 'unassigned' ELSE 'delivered' END;
END;
$$;
-- No public/service RPC for the internal bypass-RLS helper: trigger and
-- admin-authorized wrapper invoke it as the trusted owner only.
REVOKE ALL ON FUNCTION public.f10_deliver_reviewer_event(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.f10_notify_reviewers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE event_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    -- Terminal or new review transitions retire undelivered old events. Old
    -- delivered alerts remain immutable historical records.
    IF NEW.status NOT IN ('submitted', 'under_review') THEN
      UPDATE public.reviewer_notification_events SET outcome = 'inactive'
        WHERE request_id = NEW.id AND outcome IN ('pending', 'unassigned', 'failed');
      RETURN NEW;
    END IF;
    IF NEW.status <> 'under_review' THEN RETURN NEW; END IF;
  ELSE
    IF NEW.status <> 'submitted' THEN RETURN NEW; END IF;
  END IF;
  UPDATE public.reviewer_notification_events SET outcome = 'superseded'
    WHERE request_id = NEW.id AND outcome IN ('pending', 'unassigned', 'failed');
  INSERT INTO public.reviewer_notification_events (request_id, request_number, reason)
    VALUES (NEW.id, NEW.request_number, NEW.status::text) RETURNING id INTO event_id;
  PERFORM public.f10_deliver_reviewer_event(event_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'F10 event could not be recorded (SQLSTATE %).', SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.f10_notify_reviewers() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.f10_retry_reviewer_event(_event_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF public.f10_reviewer_access() IS NOT TRUE OR public.has_role(auth.uid(), 'admin'::public.app_role) IS NOT TRUE THEN
    RAISE EXCEPTION 'Access restricted' USING ERRCODE = '42501';
  END IF;
  -- Definer bypasses RLS. This exact-admin wrapper relies on today's existing
  -- global admin request SELECT. Future scoped admin policies require replacing
  -- this wrapper before deployment; it does not impersonate recipient RLS.
  IF NOT EXISTS (SELECT 1 FROM public.reviewer_notification_events e WHERE e.id = _event_id) THEN
    RETURN 'missing';
  END IF;
  RETURN public.f10_deliver_reviewer_event(_event_id);
END;
$$;
REVOKE ALL ON FUNCTION public.f10_retry_reviewer_event(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.f10_retry_reviewer_event(uuid) TO authenticated;
-- Create last: generation is enabled immediately on installation.
CREATE TRIGGER f10_notify_reviewers AFTER INSERT OR UPDATE OF status ON public.financial_requests
  FOR EACH ROW EXECUTE FUNCTION public.f10_notify_reviewers();
