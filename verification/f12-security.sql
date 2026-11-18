-- Read-only security regression checks. Every row must return passed = true.
SELECT 'authenticated can execute role checks' AS test,
  has_function_privilege('authenticated', 'public.has_role(uuid,public.app_role)', 'EXECUTE') AS passed
UNION ALL
SELECT 'authenticated can execute reviewer checks',
  has_function_privilege('authenticated', 'public.is_admin_or_reviewer(uuid)', 'EXECUTE')
UNION ALL
SELECT 'anonymous cannot execute role checks',
  NOT has_function_privilege('anon', 'public.has_role(uuid,public.app_role)', 'EXECUTE')
UNION ALL
SELECT 'anonymous cannot execute reviewer checks',
  NOT has_function_privilege('anon', 'public.is_admin_or_reviewer(uuid)', 'EXECUTE')
UNION ALL
SELECT 'request and role tables retain row-level security', bool_and(relrowsecurity)
FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
WHERE nspname = 'public' AND relname IN ('financial_requests', 'request_attachments', 'user_roles', 'profiles', 'workflow_events');