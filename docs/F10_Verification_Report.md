# F10 — Automated Reviewer Notifications (code-only)

## Scope and approval

Implemented on `feature/f10-reviewer-notifications` under the November 18, 2026 **code-only** approval. No database tool executed mutations. No migration was applied, no database policies/grants changed, no accounts/roles or existing records changed, no configuration or dependencies changed, and nothing was merged or published.

**F10 automated delivery is not enabled.** The proposed SQL is review material outside both migration runners. Applying any SQL requires separate explicit approval because preview and production share the database.

## Before / after

Before: the bell displayed only F11 requester updates; All Requests had no notification deep-link selector.

After (application code):
- The bell retains F11 updates and independently supports a reviewer feed, combined unread badge, secure request-number links, and explicit reviewer mark-read/mark-unread actions.
- Every reviewer read and state change checks the existing server-validated reviewer/admin helper. No reviewer role returns an inactive feed without querying the optional notification table. Role-check failures fail closed.
- Missing optional tables show “not enabled yet”; permission failures show restricted access; other failures show unavailable feedback. Reviewer failures do not clear or modify F11 records or feed state.
- Reads/writes are recipient-scoped. Unexpected foreign recipients and duplicate event/recipient rows are dropped. Reads use cancellation and identity guards with the existing F9 scheduler pattern; there is no Realtime subscription or browser notification generation.
- `/requests?request=<UUID>` opens only a currently authorized persisted request. The parameter is not an external redirect, a permission grant, or an export dataset. Missing/inaccessible targets receive neutral feedback; read failures suppress details. Existing F12 controls and F23 visible-row export ordering remain unchanged.
- Existing request submission, routing, F9 tracking, F11 generation/service/storage semantics, and F23 export code are unchanged.

After **future approval/application** (proposed SQL only, not verified delivery):
- New submission and genuine transition into `under_review` create an attention event and private alerts for the existing reviewer/admin pool. No named assignment mapping exists; no queue assignment is invented.
- A unique event/recipient constraint and locked delivery helper prevent duplicate retry/concurrent alerts. A later genuine transition has a new event.
- No reviewer accounts produces an internal unassigned outcome, with no recipient alerts or failed submission. Exceptions are contained; when event storage itself fails, only an internal warning survives.
- New-table RLS requires recipient identity, current reviewer/admin role, and current request read access. Only `read_at` is browser-editable; browser INSERT/DELETE and anonymous access remain absent.
- Proposed internal outcomes and explicit admin retry function support future operational recovery; **no admin delivery-outcome/retry UI or automatic backfill is implemented**.

## Actual verification results

- Full automated suite: **241/241 passed across 15 files** (`bunx vitest run`).
- Focused F10/F9/F11/F12/F23 suite: **132/132 passed across 7 files**.
- New F10 application tests: **34/34 passed**. Coverage includes authorized-only reads, missing roles, signed-out/MFA denial, authorization failure, missing tables, access/unavailable feedback, foreign recipients, duplicate/repeated events, read/unread/no-op writes, role revocation, write failures, cancellation/late responses, safe UUID links, denied/prototype/hidden targets, and source-order preservation.
- Existing F11 tests: **16/16 passed**, unchanged.
- Platform automatic check: latest successful entry at **2026-11-18T07:37:54Z: `build OK`**. An initial TypeScript error from attaching cancellation after `maybeSingle()` was corrected by attaching it before finalizing the query; the later automatic check passed. No manual production build/typecheck was run, following the project workflow.
- Browser: a signed-out visit to `/requests?request=12345678-1234-1234-1234-123456789abc` redirected to `/login`; zero request dialogs appeared, and no page errors were reported. Screenshot visually confirmed the sign-in screen. No submitted credentials or account creation occurred.
- Inspected all leaf routes: existing unique titles/descriptions and Open Graph/Twitter metadata are present; no unrelated page changes were needed.

## Changed files and why

| File | Purpose |
| --- | --- |
| `src/lib/reviewer-notifications.ts` | Browser-safe private reviewer service, deduplication, error classification, and authorized request-link selection. |
| `src/lib/reviewer-notification-client.ts` | Typed optional-table view of the existing browser client; generated types remain untouched. |
| `src/lib/reviewer-notifications-data.ts` | Server-validated role checks, recipient-scoped reads/state changes, and identity-scoped cancellation/polling. |
| `src/lib/reviewer-notifications.test.ts` | 34 concrete application behavior tests. |
| `src/components/ReviewerNotificationItems.tsx` | Reviewer feed and read/unread controls using existing design components/tokens. |
| `src/components/RequesterNotifications.tsx` | Adds the separate reviewer section to the existing bell; F11 service, records, generation, links, and acknowledgment are unchanged. |
| `src/routes/requests.tsx` | Validated secure detail links resolved from authorized current rows without changing filtered exports. |
| `docs/f10/reviewer-notifications.proposed.sql` | Unapplied schema/trigger/RLS/grant/retry proposal for explicit review; outside migration runners. |
| `docs/f10/database-verification.proposed.sql` | Unexecuted rollback-only delivery/privacy/read-state assertions for a future isolated authorized environment. |
| `docs/F10_Verification_Report.md` | This report, actual results, and enablement blockers. |
| `AGENTS.md` | Records the optional-table/server-authorized boundary and review-only SQL location. |
| `roadmap.md` | Approved code-only tasks and blocked enablement/verification tasks. |
| `.lovable/plan.md` | Targeted revision recording code-only approval and prohibiting shared-database execution. |

## Remaining blockers / limitations

1. **Explicit database approval required:** proposed tables/triggers/RLS/grants are not applied. No real reviewer alerts are generated by this code-only delivery.
2. **Existing reviewer/admin account required:** inspection found no assigned roles. No accounts or roles were created. Hosted recipient creation, role-revocation privacy, no-reviewer trigger behavior, concurrent delivery, and failure recovery have not been exercised against a database; application unit tests are not evidence of SQL execution.
3. **Signed-in preview verification blocked:** current browser auth status is `signed_out`; an attempt to restore the requesting user's own account reported no matching account. No alternate user was selected and no test account was created. Signed-in F11/F10 bell, requester submission, reviewer link/read/unread, mobile reviewer layout, and sign-out cancellation were not browser-verified in this turn.
4. **No queue-specific assignment/stage escalation:** routing has queue labels but no protected individual mapping; F16 stage storage is absent. Alerts cover submission and transitions into review, not every future SLA event.
5. **No email/direct distribution**, background worker, retry UI, or retroactive role-assignment fan-out. Internal event outcomes/retry SQL is proposed only.
6. A signed-out link reaches the existing login gate; automatic restoration of the intended request URL after login is not added. Reopen the secure link after signing in.

No dependency changes or unrelated feature changes were included.