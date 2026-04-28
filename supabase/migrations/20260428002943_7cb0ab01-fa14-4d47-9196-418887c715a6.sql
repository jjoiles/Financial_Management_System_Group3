REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM anon;
REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM authenticated;

REVOKE ALL ON FUNCTION public.is_admin_or_reviewer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_reviewer(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_or_reviewer(UUID) FROM authenticated;