REVOKE ALL ON TABLE public.requester_status_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.requester_status_notifications TO authenticated;
GRANT UPDATE (read_at) ON TABLE public.requester_status_notifications TO authenticated;
GRANT ALL ON TABLE public.requester_status_notifications TO service_role;