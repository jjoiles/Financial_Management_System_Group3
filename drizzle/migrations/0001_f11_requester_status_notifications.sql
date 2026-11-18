CREATE TABLE public.requester_status_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  request_number text NOT NULL,
  previous_status public.request_status,
  new_status public.request_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
GRANT SELECT ON public.requester_status_notifications TO authenticated;
GRANT UPDATE (read_at) ON public.requester_status_notifications TO authenticated;
GRANT ALL ON public.requester_status_notifications TO service_role;
ALTER TABLE public.requester_status_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Requesters read their own status alerts" ON public.requester_status_notifications
  FOR SELECT TO authenticated USING (recipient_user_id = auth.uid());
CREATE POLICY "Requesters acknowledge their own status alerts" ON public.requester_status_notifications
  FOR UPDATE TO authenticated USING (recipient_user_id = auth.uid()) WITH CHECK (recipient_user_id = auth.uid());
CREATE INDEX requester_status_notifications_owner_created_idx
  ON public.requester_status_notifications (recipient_user_id, created_at DESC, id);
CREATE FUNCTION public.f11_notify_requester_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.requester_status_notifications
      (request_id, recipient_user_id, request_number, previous_status, new_status)
    VALUES (NEW.id, NEW.user_id, NEW.request_number, OLD.status, NEW.status);
  ELSE
    INSERT INTO public.requester_status_notifications
      (request_id, recipient_user_id, request_number, new_status)
    VALUES (NEW.id, NEW.user_id, NEW.request_number, NEW.status);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'F11 status notification could not be recorded (SQLSTATE %).', SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.f11_notify_requester_status() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER f11_notify_requester_status
AFTER INSERT OR UPDATE OF status ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f11_notify_requester_status();