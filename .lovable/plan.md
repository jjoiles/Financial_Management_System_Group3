# F10 — Automated Reviewer Notifications

## Review findings
- Confirmed the current branch is `feature/f10-reviewer-notifications`; the working tree was clean.
- Submission saves a request before starting the workflow. Routing identifies office queues, not individual reviewers.
- F11 already provides persisted private alerts, owner-scoped reads, read acknowledgement, error feedback, and identity-scoped 30-second checks. Reuse these patterns and the existing bell without changing requester alert semantics.
- Existing request access permits admins/reviewers to read all financial requests. Notification links must still load through this existing authorization, never grant request access.
- The hosted database currently has **no reviewer/admin role records**, **no named reviewer assignment mapping**, and **no F16 approval-stage table**.
- Preview and the published app share one database. Applying a change here also changes the production database.

## Proposed behavior
1. Notify the existing authorized reviewer/admin pool on persisted submission and on a genuine transition into `under_review`. Because no assignment mapping exists, this is an authorized review-pool alert, not a claim that a particular person was assigned a queue.
2. Include the request number, alert reason, date, and a same-origin link to `/requests?request=<UUID>`. The existing All Requests page opens details only after an authorized read; malformed, missing, or inaccessible requests show safe feedback. Links do not bypass sign-in or verification.
3. Extend the existing bell with reviewer updates while keeping requester updates independent. Support explicit mark-read and mark-unread controls for reviewer alerts; failures must not clear unrelated requester alerts or imply successful delivery.
4. Preserve F9 tracking checks, F11 persisted requester alerts, F12 search/filter/sort, and F23 exports. Deep-link detail loading must not alter the filtered export dataset.
5. Create alerts only for persisted requests, not local prototypes. With no eligible reviewers, save the request normally and record an internal unassigned outcome, without inventing recipients or claiming delivery.

## Technical details and approval scope
**This plan requests approval for an additive change to the shared production database**, limited to F10:
- A separate reviewer notification table, with a recipient ID, request ID/number, event ID/reason, timestamps, and read state.
- Explicit authenticated SELECT and column-only UPDATE of `read_at`; service-only generation. No anonymous access, browser INSERT/DELETE, or changes to existing request/role/F11 permissions.
- New row-level policies require the signed-in recipient, a current reviewer/admin role, and current request read permission. Losing the role removes alert access.
- Persisted attention-event IDs and a unique `(event_id, recipient_user_id)` constraint prevent retry/concurrent duplicates while allowing a later genuine attention transition to produce a new alert.
- A database trigger generates alerts from committed INSERT/status transitions, using protected role records rather than client role switches or user-editable routing metadata. No notification for no-op status updates or unrelated workflow retries.
- Store pending/unassigned/failed event outcomes for controlled, idempotent retry through an authenticated admin-only function; authorize using the existing caller-bound role helper. Do not grant or elevate any user's role. Log failure details internally and preserve request submission if alert generation fails; surface failure/unassigned outcomes to authorized admins, not requesters.
- No Realtime publication, authentication/provider, package dependency, email, Power Automate, or deployment configuration changes.
- No historical alert backfill or automatic retroactive fan-out. Queue-specific assignments and F16 stage/escalation notifications are out of scope until those prerequisites exist.

## Verification
- Add concrete automated tests for recipients, role revocation/access denial, event deduplication, repeated attention transitions, read/unread changes, safe links, no reviewers, unavailable notifications, and preserved F11 behavior.
- Add rollback-only database integration tests for private access, grants, trigger delivery, idempotent retries, and non-blocking failures. Run only with available authorized privileges; never elevate to force tests through.
- Run the full automated suite and inspect platform TypeScript/production checks; do not manually run builds.
- Verify requester regression flows using the existing session. A real reviewer end-to-end delivery/read/link check is **blocked until an authorized reviewer account is available**; do not create accounts or assign roles without separate approval. Controlled browser responses are not proof of real reviewer delivery.
- Produce `docs/F10_Verification_Report.md` listing exact changed files, before/after behavior, actual results, and any blocked checks. Commit only on the current feature branch; no merge or publish.

## Approval decision
Approve this plan to authorize implementation and the narrowly scoped **shared-database F10 schema, trigger, and new-table permissions** above. Existing request/role/F11 permissions and production configuration remain unchanged. If shared-database changes are not approved, only a non-enabled frontend and test implementation can be prepared; persisted automated reviewer notifications cannot honestly be delivered using the current schema.