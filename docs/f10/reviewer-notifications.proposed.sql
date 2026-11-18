-- REVIEW ONLY / NOT APPLIED. Requires separate explicit approval.
-- Kept outside drizzle/migrations and supabase/migrations intentionally.
-- No historical backfill, account/role edits, or existing permission changes.

CREATE TABLE public.reviewer_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  request_number text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('submitted', 'under_review')),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'delivered', 'unassigned', 'failed')),
  recipient_count integer NOT NULL DEFAULT 0,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.reviewer_notification_events TO authenticated;
GRANT ALL ON public.reviewer_notification_events TO service_role;
ALTER TABLE public.reviewer_notification_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read reviewer delivery outcomes" ON public.reviewer_notification_events
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );

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
GRANT SELECT ON public.reviewer_notifications TO authenticated;
GRANT UPDATE (read_at) ON public.reviewer_notifications TO authenticated;
GRANT ALL ON public.reviewer_notifications TO service_role;
ALTER TABLE public.reviewer_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reviewers read their own authorized alerts" ON public.reviewer_notifications
  FOR SELECT TO authenticated USING (
    recipient_user_id = auth.uid()
    AND public.is_admin_or_reviewer(auth.uid())
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );
CREATE POLICY "Reviewers change own alert read state" ON public.reviewer_notifications
  FOR UPDATE TO authenticated USING (
    recipient_user_id = auth.uid()
    AND public.is_admin_or_reviewer(auth.uid())
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  ) WITH CHECK (
    recipient_user_id = auth.uid()
    AND public.is_admin_or_reviewer(auth.uid())
    AND EXISTS (SELECT 1 FROM public.financial_requests r WHERE r.id = request_id)
  );
CREATE INDEX reviewer_notifications_recipient_created_idx
  ON public.reviewer_notifications (recipient_user_id, created_at DESC, id);

-- Internal delivery helper, not callable by browser users. Reads protected
-- role rows directly inside a definer, never checks another user via the
-- existing caller-bound is_admin_or_reviewer helper.
CREATE FUNCTION public.f10_deliver_reviewer_event(_event_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attention public.reviewer_notification_events%ROWTYPE;
  recipients integer;
  error_code text;
BEGIN
  SELECT * INTO attention FROM public.reviewer_notification_events
    WHERE id = _event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  -- A delivered event is immutable: retry never fans it out to new users.
  IF attention.outcome = 'delivered' THEN RETURN 'delivered'; END IF;
  -- Do not deliver a stale retry once attention is no longer required.
  IF NOT EXISTS (SELECT 1 FROM public.financial_requests r
    WHERE r.id = attention.request_id AND r.status IN ('submitted', 'under_review')) THEN
    RETURN 'inactive';
  END IF;
  BEGIN
    INSERT INTO public.reviewer_notifications
      (event_id, request_id, recipient_user_id, request_number, reason)
    SELECT attention.id, attention.request_id, u.user_id, attention.request_number, attention.reason
    FROM (SELECT DISTINCT user_id FROM public.user_roles WHERE role IN ('reviewer', 'admin')) u
    ON CONFLICT (event_id, recipient_user_id) DO NOTHING;
    SELECT count(*) INTO recipients FROM public.reviewer_notifications WHERE event_id = attention.id;
    UPDATE public.reviewer_notification_events SET
      outcome = CASE WHEN recipients = 0 THEN 'unassigned' ELSE 'delivered' END,
      recipient_count = recipients, failure_code = NULL WHERE id = attention.id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_code = RETURNED_SQLSTATE;
    UPDATE public.reviewer_notification_events SET outcome = 'failed', failure_code = error_code
      WHERE id = attention.id;
    RAISE WARNING 'F10 reviewer delivery failed (SQLSTATE %).', error_code;
    RETURN 'failed';
  END;
  RETURN CASE WHEN recipients = 0 THEN 'unassigned' ELSE 'delivered' END;
END;
$$;
REVOKE ALL ON FUNCTION public.f10_deliver_reviewer_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f10_deliver_reviewer_event(uuid) TO service_role;

CREATE FUNCTION public.f10_notify_reviewers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  event_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' THEN RETURN NEW; END IF;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'under_review' THEN
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO public.reviewer_notification_events (request_id, request_number, reason)
    VALUES (NEW.id, NEW.request_number, NEW.status::text) RETURNING id INTO event_id;
  PERFORM public.f10_deliver_reviewer_event(event_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never reject a saved request because the notification infrastructure fails.
  -- If even event storage fails, only a warning survives; do not claim delivery.
  RAISE WARNING 'F10 reviewer event could not be recorded (SQLSTATE %).', SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.f10_notify_reviewers() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER f10_notify_reviewers
  AFTER INSERT OR UPDATE OF status ON public.financial_requests
  FOR EACH ROW EXECUTE FUNCTION public.f10_notify_reviewers();

-- Explicit controlled retry; no scheduled backfill or automatic retroactive delivery.
CREATE FUNCTION public.f10_retry_reviewer_event(_event_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Access restricted' USING ERRCODE = '42501';
  END IF;
  RETURN public.f10_deliver_reviewer_event(_event_id);
END;
$$;
REVOKE ALL ON FUNCTION public.f10_retry_reviewer_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f10_retry_reviewer_event(uuid) TO authenticated;