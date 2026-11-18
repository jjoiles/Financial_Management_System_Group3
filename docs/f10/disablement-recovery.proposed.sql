-- REVIEW ONLY / UNEXECUTED. Separate explicit approval required.
-- NON-DESTRUCTIVE STOP: preserve requests, roles, F11 and all F10 history.
-- Apply atomically using the approved workflow, with a reviewed lock timeout.
ALTER TABLE public.financial_requests DISABLE TRIGGER f10_notify_reviewers;
REVOKE EXECUTE ON FUNCTION public.f10_retry_reviewer_event(uuid) FROM authenticated;
-- No table/policy/record deletions; existing private read/read-state access stays.
-- To stop F10 reads too, separately approve revoking only its table SELECT and
-- read_at UPDATE grants and deploy a reviewer-feed disable switch. Never weaken RLS.

-- RECOVERY (NOT AUTOMATIC; DO NOT RUN AS PART OF STOP):
-- 1. Diagnose the incident; validate exact-role/AAL2 RLS, grants and trusted
--    function owner. Correct SQL/code in isolated clone and obtain approval.
-- 2. Re-enable retry grant ONLY after approval; inventory current latest failed /
--    unassigned events using an AAL2 admin. Review each request before retry.
-- 3. Enable trigger ONLY after approval. Do not replay submissions during the
--    disabled interval; those were saved without F10 events. Reconciliation of
--    this gap requires a separate scoped, idempotent plan, never automatic backfill.
-- 4. Keep delivered events immutable; superseded/inactive events are never retried.
-- 5. Verify real reviewer/F11 flow and monitor latency/failures after recovery.
-- Proposed inverse operations, intentionally commented:
-- GRANT EXECUTE ON FUNCTION public.f10_retry_reviewer_event(uuid) TO authenticated;
-- ALTER TABLE public.financial_requests ENABLE TRIGGER f10_notify_reviewers;
