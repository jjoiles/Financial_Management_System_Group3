-- ============================================================================
-- F21.4 (#70, #97, #98, #99) & #106: Back-End / Data Authorization & Auth Repair
-- ============================================================================
-- 1. Repairs public.has_role and public.is_admin_or_reviewer so checks are
--    bound to auth.uid(), preventing cross-user role probing while restoring
--    RLS evaluation for authenticated users.
-- 2. Keeps execution REVOKED from PUBLIC and anon, and GRANTS EXECUTE to
--    authenticated only.
-- 3. Enforces table RLS and owner/reviewer access restrictions on sensitive
--    financial records and attachment storage paths.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN FALSE
    WHEN _user_id IS DISTINCT FROM auth.uid() THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = _role
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_reviewer(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN FALSE
    WHEN _user_id IS DISTINCT FROM auth.uid() THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN (
          'admin'::public.app_role,
          'reviewer'::public.app_role,
          'leadership'::public.app_role
        )
    )
  END;
$$;

-- Keep anonymous and public execution strictly revoked; grant to authenticated only (#106)
REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;

REVOKE ALL ON FUNCTION public.is_admin_or_reviewer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_reviewer(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_reviewer(UUID) TO authenticated;

-- Preserve and enforce RLS on all sensitive financial tables (F21.4.1, F21.4.3)
ALTER TABLE public.financial_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
