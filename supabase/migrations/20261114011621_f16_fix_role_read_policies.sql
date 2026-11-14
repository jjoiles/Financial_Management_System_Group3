-- ============================================================
-- F16: FIX ROLE AND PROFILE READ POLICIES
-- ============================================================
--
-- Replaces legacy RLS policies that call restricted helpers.
-- Uses SECURITY DEFINER F16 helpers instead.
--
-- Preserves:
--   - Users can read their own profiles.
--   - Reviewers, admins, and leadership can access profiles.
--   - Users can read their own role records.
--   - Only admins can manage user role records.
--
-- ============================================================


-- ============================================================
-- 1. SECURE ADMIN AUTHORIZATION HELPER
-- ============================================================

CREATE OR REPLACE FUNCTION public.f16_is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.role = 'admin'::public.app_role
    );
$$;

REVOKE ALL
ON FUNCTION public.f16_is_admin()
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.f16_is_admin()
FROM anon;

GRANT EXECUTE
ON FUNCTION public.f16_is_admin()
TO authenticated;


-- ============================================================
-- 2. FIX PROFILE SELECT POLICY
-- ============================================================

DROP POLICY IF EXISTS
    "Users can view their own profile"
ON public.profiles;

CREATE POLICY "Users can view their own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (
    auth.uid() = user_id
    OR public.f16_is_admin_or_reviewer()
);


-- ============================================================
-- 3. FIX USER ROLE SELECT POLICY
-- ============================================================

DROP POLICY IF EXISTS
    "Users can view their own role records"
ON public.user_roles;

DROP POLICY IF EXISTS
    "Admins can manage role records"
ON public.user_roles;

CREATE POLICY "Users can view their own role records"
ON public.user_roles
FOR SELECT
TO authenticated
USING (
    auth.uid() = user_id
    OR public.f16_is_admin()
);


-- ============================================================
-- 4. RESTORE ADMIN ROLE MANAGEMENT PERMISSIONS
-- ============================================================

CREATE POLICY "Admins can insert role records"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (
    public.f16_is_admin()
);

CREATE POLICY "Admins can update role records"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (
    public.f16_is_admin()
)
WITH CHECK (
    public.f16_is_admin()
);

CREATE POLICY "Admins can delete role records"
ON public.user_roles
FOR DELETE
TO authenticated
USING (
    public.f16_is_admin()
);


-- ============================================================
-- END F16 ROLE READ POLICY FIX
-- ============================================================
