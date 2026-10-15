-- F6: Automated Record Linking
--
-- 1. Foreign keys from every user_id column to auth.users, so records cannot
--    point at users that do not exist (DEBT_AND_RISK, missing FKs).
-- 2. financial_requests.requester_profile_id, filled in automatically.
-- 3. request_links: related requests found and linked by the database
--    (same grant, same university program, possible duplicate).
--
-- Foreign keys are NOT VALID so existing orphaned prototype rows do not block
-- the migration. New rows are checked. Validate after cleanup with:
--   ALTER TABLE <table> VALIDATE CONSTRAINT <name>;

-- 1. User foreign keys -------------------------------------------------------
-- Profiles and roles belong to the account and go with it.
-- Financial records and attachments are kept: deleting a user who has
-- requests is blocked, so financial history is never silently erased.
-- Log entries keep their history and lose only the actor.

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.financial_requests
  ADD CONSTRAINT financial_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.request_attachments
  ADD CONSTRAINT request_attachments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.workflow_events
  ADD CONSTRAINT workflow_events_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;

CREATE INDEX IF NOT EXISTS financial_requests_user_id_idx ON public.financial_requests (user_id);
CREATE INDEX IF NOT EXISTS request_attachments_request_id_idx ON public.request_attachments (request_id);

-- 2. Requester profile link --------------------------------------------------

ALTER TABLE public.financial_requests
  ADD COLUMN IF NOT EXISTS requester_profile_id UUID
  REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.f6_link_requester_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.requester_profile_id IS NULL OR TG_OP = 'INSERT' THEN
    SELECT id INTO NEW.requester_profile_id
    FROM public.profiles WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f6_link_requester_profile ON public.financial_requests;
CREATE TRIGGER f6_link_requester_profile
BEFORE INSERT ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f6_link_requester_profile();

-- Backfill existing requests. Row by row, so an old row that fails a newer
-- F22 rule is skipped instead of failing the whole migration.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT fr.id, p.id AS profile_id
    FROM public.financial_requests fr
    JOIN public.profiles p ON p.user_id = fr.user_id
    WHERE fr.requester_profile_id IS NULL
  LOOP
    BEGIN
      UPDATE public.financial_requests SET requester_profile_id = r.profile_id WHERE id = r.id;
    EXCEPTION WHEN check_violation OR raise_exception THEN
      RAISE NOTICE 'F6 backfill skipped request % (fails validation)', r.id;
    END;
  END LOOP;
END;
$$;

-- A profile created after the user's first request links back to it.
CREATE OR REPLACE FUNCTION public.f6_link_profile_to_requests()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Row by row so one legacy row that fails F22 rules can never block a
  -- profile from being created (that would break sign-up).
  FOR r IN
    SELECT id FROM public.financial_requests
    WHERE user_id = NEW.user_id AND requester_profile_id IS NULL
  LOOP
    BEGIN
      UPDATE public.financial_requests SET requester_profile_id = NEW.id WHERE id = r.id;
    EXCEPTION WHEN check_violation OR raise_exception THEN
      NULL;
    END;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f6_link_profile_to_requests ON public.profiles;
CREATE TRIGGER f6_link_profile_to_requests
AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.f6_link_profile_to_requests();

-- 3. Related request links ---------------------------------------------------

CREATE TABLE IF NOT EXISTS public.request_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  linked_request_id UUID NOT NULL REFERENCES public.financial_requests(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('same_grant', 'same_program', 'possible_duplicate')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT request_links_not_self CHECK (request_id <> linked_request_id),
  CONSTRAINT request_links_unique UNIQUE (request_id, linked_request_id, link_type)
);

CREATE INDEX IF NOT EXISTS request_links_request_id_idx ON public.request_links (request_id);
CREATE INDEX IF NOT EXISTS financial_requests_grant_number_idx
  ON public.financial_requests (lower(grant_number)) WHERE grant_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_requests_university_program_idx
  ON public.financial_requests (lower(university_program)) WHERE university_program IS NOT NULL;

ALTER TABLE public.request_links ENABLE ROW LEVEL SECURITY;

-- A link is visible only when the user can see both requests, so a link
-- never reveals that someone else's request exists.
CREATE POLICY "Users can view links between permitted requests"
ON public.request_links FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.financial_requests a
    WHERE a.id = request_links.request_id
      AND (a.user_id = auth.uid() OR public.is_admin_or_reviewer(auth.uid()))
  )
  AND EXISTS (
    SELECT 1 FROM public.financial_requests b
    WHERE b.id = request_links.linked_request_id
      AND (b.user_id = auth.uid() OR public.is_admin_or_reviewer(auth.uid()))
  )
);

-- Reviewers can dismiss a link (e.g. a false duplicate). Links are only ever
-- created by the trigger below.
CREATE POLICY "Reviewers can dismiss links"
ON public.request_links FOR DELETE TO authenticated
USING (public.is_admin_or_reviewer(auth.uid()));

-- Writes one link in both directions and logs it (F5 event stream).
CREATE OR REPLACE FUNCTION public.f6_add_link(
  _a UUID, _b UUID, _type TEXT, _reason TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted INT;
  b_number TEXT;
BEGIN
  INSERT INTO public.request_links (request_id, linked_request_id, link_type, reason)
  VALUES (_a, _b, _type, _reason), (_b, _a, _type, _reason)
  ON CONFLICT ON CONSTRAINT request_links_unique DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF inserted > 0 THEN
    SELECT request_number INTO b_number FROM public.financial_requests WHERE id = _b;
    INSERT INTO public.workflow_events (request_id, actor_user_id, event_type, message, metadata)
    VALUES (
      _a, NULL, 'record_linked',
      format('Linked to %s: %s', b_number, _reason),
      jsonb_build_object('source', 'db_trigger', 'linkedRequestId', _b,
                         'linkedRequestNumber', b_number, 'linkType', _type)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.f6_link_related_requests()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  other RECORD;
BEGIN
  -- Same grant number (case-insensitive): research spending on one grant.
  IF NEW.grant_number IS NOT NULL THEN
    FOR other IN
      SELECT id FROM public.financial_requests
      WHERE id <> NEW.id AND lower(grant_number) = lower(NEW.grant_number)
      ORDER BY created_at DESC LIMIT 25
    LOOP
      PERFORM public.f6_add_link(NEW.id, other.id, 'same_grant',
        format('Same grant number %s.', NEW.grant_number));
    END LOOP;
  END IF;

  -- Same university program.
  IF NEW.university_program IS NOT NULL THEN
    FOR other IN
      SELECT id FROM public.financial_requests
      WHERE id <> NEW.id AND lower(university_program) = lower(NEW.university_program)
      ORDER BY created_at DESC LIMIT 25
    LOOP
      PERFORM public.f6_add_link(NEW.id, other.id, 'same_program',
        format('Same university program %s.', NEW.university_program));
    END LOOP;
  END IF;

  -- Possible duplicate: same requester, department, funding source, and
  -- amount within 7 days, not already rejected.
  FOR other IN
    SELECT id FROM public.financial_requests
    WHERE id <> NEW.id
      AND user_id = NEW.user_id
      AND lower(department) = lower(NEW.department)
      AND funding_source = NEW.funding_source
      AND amount = NEW.amount
      AND status <> 'rejected'
      AND created_at BETWEEN NEW.created_at - interval '7 days' AND NEW.created_at + interval '7 days'
    LIMIT 10
  LOOP
    PERFORM public.f6_add_link(NEW.id, other.id, 'possible_duplicate',
      'Same requester, department, funding source, and amount within 7 days.');
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS f6_link_related_requests ON public.financial_requests;
CREATE TRIGGER f6_link_related_requests
AFTER INSERT OR UPDATE OF grant_number, university_program, amount, department, funding_source
ON public.financial_requests
FOR EACH ROW EXECUTE FUNCTION public.f6_link_related_requests();

REVOKE ALL ON FUNCTION public.f6_add_link(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f6_link_related_requests() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f6_link_requester_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.f6_link_profile_to_requests() FROM PUBLIC, anon, authenticated;
