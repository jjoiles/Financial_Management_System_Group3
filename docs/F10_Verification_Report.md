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
## Security remediation — November 18, 2026

This section supersedes the initial authorization/grant/event-handling descriptions above. Code-only corrections were made after the read-only review; no SQL was executed and PR #205 remains unmerged.

### Corrections

- Replaced the leadership-inclusive RPC in the F10 adapter with existing RLS-protected **own raw role rows**, checked by `hasF10ReviewerAccess`. Only exact reviewer/admin plus current AAL2 passes. Presentation roles, mapped roles and shared `is_admin_or_reviewer` are not used by F10. No shared helper or F12 behavior changed.
- Prepared a dedicated zero-argument `f10_reviewer_access()` definer helper bound to `auth.uid()`, exact roles and `auth.jwt()->>'aal' = 'aal2'`. Missing claims return false, never NULL. All F10 SELECT/UPDATE policies and the admin retry wrapper require this check. Retry additionally requires exact admin; missing/null authorization fails closed.
- Restricted definer search paths to `pg_catalog, pg_temp`, with schema-qualified application/auth objects. Explicitly revoked PUBLIC/anon/authenticated/service execution of internal generation functions; browser execution is limited to the caller-bound boolean helper and admin-checked retry wrapper. The service role still has intentional table generation privileges, not public RPC execution of the internal helper.
- Explicitly reset new-table/sequence privileges before granting narrow SELECT and read_at-only UPDATE to authenticated and required trusted service grants. No existing-table, role or F11 grant changes are proposed. Effective inherited privileges/function ownership must still be inspected before enablement.
- Added stable per-event identity ordering, request/event indexes, recipient-count validation, and persisted `superseded`/`inactive` outcomes. Delivery locks request then event, matching the trigger's request lock order. Older undelivered events are superseded on a new review transition; pending events retire on terminal transitions. Delivered alerts remain immutable history and genuine later transitions get new events. Same-event recipient uniqueness remains the database concurrency guard.
- Added `docs/f10/disablement-recovery.proposed.sql`: stop only the F10 trigger and retry execution, preserving requests, roles, F11 and F10 history. Recovery inverse operations are commented, require separate approval and isolated validation; no automatic gap backfill or table destruction.
- Expanded isolated-only SQL assertions to cover exact roles, leadership-only/requester denial, two-recipient isolation, anonymous grants, AAL1 reviewer/admin denial, column privileges, role revocation, admin-only retry, no-op/repeated transitions, missing reviewers, stale events, injected delivery failure/retry and F11 coexistence. Fixtures are scoped to the new request/event; no accounts are created. The test file intentionally contains rollback-scoped role removals and failure-injection DDL **only for a separately approved isolated clone**, never shared production.

### Actual updated results

- Full application suite: **253/253 passed, 15 files** at 07:51:05 UTC.
- F10 application tests: **46/46** (34 existing plus 12 exact-role/AAL2 tests); includes leadership retention after reviewer revocation, unknown/missing assurance, and dual roles.
- Platform TypeScript/build signal: **build OK at 07:50:57 UTC** after correcting test parameterization. No manual builds/typechecks were run.
- **All proposed SQL/database integration tests: UNEXECUTED.** No isolated database was supplied or used. Application test results do not establish trigger correctness, actual grants, SQL validity, lock/concurrency behavior, real AAL2 Data API enforcement or F11 database coexistence.
- No signed-in reviewer browser verification was claimed. Existing authorized reviewer/admin and requester sessions plus separately approved installed schema remain prerequisites.

### Updated changed files for this remediation

`src/lib/reviewer-notifications.ts`, `src/lib/reviewer-notifications-data.ts`, `src/lib/reviewer-notifications.test.ts`, `docs/f10/reviewer-notifications.proposed.sql`, `docs/f10/database-verification.proposed.sql`, new `docs/f10/disablement-recovery.proposed.sql`, `docs/F10_Verification_Report.md`, `AGENTS.md`, and `roadmap.md`. No package, auth configuration, generated schema, existing migration, shared helper or F9/F11/F12/F23 algorithm changed.

### Remaining risks and deployment prerequisites

1. **No production enablement approval:** all SQL remains outside migration runners. Future application must use a reviewed atomic migration, with helpers before policies and the trigger last; the plain CREATE proposal is not a rerunnable upgrade for an already-installed F10 schema. Verify prerequisites and object collisions first.
2. **Trusted owner/effective privilege verification:** the definer owner must be trusted, have required table/sequence rights and suitable RLS bypass, and be inaccessible through browser role membership. Check owner membership, inherited/default ACLs, anonymous denial, new column rights and internal function EXECUTE in the isolated database. Avoid unqualified public object resolution and do not grant browser schema CREATE.
3. **Recipient permission dependency:** generation intentionally uses the existing global exact reviewer/admin request access. It does not impersonate each recipient to evaluate future RLS. The admin retry wrapper likewise relies on current global admin access. Any future department/queue-scoped request policies require revising both generation and retry first. No queue assignments, suspended-account screening or self-review exclusion are invented.
4. **MFA scope:** AAL2 is required to read/change alerts and invoke admin retry. Background trigger generation is not tied to the submitting user's AAL2: it creates alerts for existing authorized recipients; recipients must use an AAL2 session to access them. Proposed SQL has not been executed to prove claim handling.
5. **Concurrency/locking:** new request/event locks serialize retries with transitions; this can increase request latency. A separate two-session scenario is documented but not executable within the one-session SQL fixture. Benchmark fan-out, lock timeouts and concurrency in an isolated clone before approval.
6. **Failure semantics:** ordinary delivery errors are contained and stored as failed; if event storage itself fails only warnings survive. Query cancellation/resource failures are not guaranteed contained by WHEN OTHERS. If the request transaction aborts, neither F10 nor F11 changes commit. Stored delivery does not mean read or email delivery.
7. **Recovery gap:** disabling generation leaves saved requests without F10 events during the interval. Re-enabling must not fabricate historical delivery. Any reconciliation needs a separate approved bounded/idempotent plan; superseded/inactive events stay retired.
8. **Tests not comprehensive database proof:** the expanded script requires five distinct EXISTING fixture identities and privileged isolated setup. Role-revocation, missing-reviewer and failure-injection cases mutate only the isolated clone under rollback; they are forbidden here. Identity sequence increments do not roll back. Add true concurrent retries, trusted-service misuse boundaries, event-storage failure and disable/recovery tests before enablement.
9. **UI limitations remain:** newest 100 alerts only, unread count limited to fetched rows, up-to-30-second polling, no retry/outcome UI, no retention policy, no email, and intended deep link not restored automatically through sign-in. These are not claims of immediate or complete delivery.

No existing production data/permissions, account assignments or configuration were changed. No isolated database was created; no SQL or proposed disablement command was executed.
