# F11 — Automated Requester Status Updates

## Before / after

- Before: the header displayed static sample notifications unrelated to the authenticated requester. Hosted request status logging was absent (only the updated-at trigger was installed), despite F5/F16 migration source files existing in the repository. No app email domain was configured.
- After: actual persisted request INSERTs and changed status UPDATEs produce private in-app alerts containing request number, new status, timestamp, and a same-origin link to the owner's request details. No amounts, justification, email address, or attachments appear in alert content. No email is sent or simulated.

## Architecture and required security changes

- Added `requester_status_notifications` plus an AFTER INSERT / UPDATE OF status trigger. Existing statuses remain submitted, under_review, approved, rejected, completed; no revision status was invented.
- Recipient comes from the saved request's `user_id`, not actor identity, requester email, browser data, or reviewer role.
- `IS NOT DISTINCT FROM` suppresses unchanged updates. A row-level trigger emits once per actual row transition; retries setting the same status emit nothing. Distinct legitimate repeated transitions retain separate IDs. Browser display also deduplicates event IDs.
- Alert insertion participates in the request transaction: rollback removes both. A notification insertion exception is caught in a subtransaction, leaves request status intact, and logs a non-sensitive SQLSTATE warning. Such a failed alert is **not retried** automatically.
- New-table RLS allows only recipient reads and acknowledgments. Authenticated clients receive SELECT and UPDATE(read_at) only; no insert, delete, recipient/status modification, or anonymous access. A follow-up migration explicitly revoked inherited default grants discovered during verification. Existing request policies, role helpers, MFA, and authentication were not modified.
- Header polls the latest 100 owner alerts every 30 seconds while visible, on window focus, on opening the bell, and on manual refresh. Identity-scoped cancellation and immediate owner checks prevent old-session responses being displayed. No realtime publication, subscription, email service, or dependency was added.
- Links pass a validated UUID to `/tracking?request=...`. Existing RLS-loaded, owner-scoped results must contain the backend request before details open; unavailable/foreign links show a neutral warning. Existing search, filters, counts, and workflow displays remain intact. F12/F23 modules and `/requests` were unchanged.

## Actual verification

- `bunx vitest run`: **195 passed, 0 failed; 13 test files**. New F11 service tests: **16 passed** (persisted transition reads, existing statuses, unchanged statuses, duplicate IDs, recipient isolation, empty persisted feed, read failure, signed-out/MFA restrictions, acknowledgments, unauthorized access, notification-write failure). F12/F23 regressions passed in the full suite.
- Automatic preview TypeScript/production checks: latest entries reported **build OK**, including after the grant correction. No manual builds/typechecks were run, as the platform performs them automatically.
- Real signed-in existing Requester flow: submitted a $11.23 verification request, persisted as `FR-2026-HWJCR8`; the bell showed Submitted; marking it read persisted (`read_at` confirmed through a database read); View request opened the correct details at `/tracking?request=fa444f82-c92e-4844-a6f7-3d524791b37d`.
- Real requester API checks: querying another recipient returned zero rows; attempting to insert a forged notification or modify `new_status` was denied. Catalog checks confirmed no authenticated INSERT/status UPDATE, no anonymous SELECT, and authenticated UPDATE(read_at).
- Controlled notification 403/42501 response displayed access-restricted feedback rather than an empty-success state. Desktop 1280×1800 and mobile 390×844 screenshots inspected; notification panel stayed within the viewport. Existing mobile header title truncation predates F11 and was not redesigned.
- Transaction-only live database insert produced exactly one Submitted alert, and rollback left neither request nor notification persisted.
- Full `verification/f11-notifications.sql` integration suite is retained for privileged CI. Execution was attempted but **blocked at request UPDATE**: managed sandbox `sandbox_exec` lacks UPDATE on `financial_requests`. Full actual changed-status, repeated-status, failed-update rollback, injected notification failure, and multi-identity SET ROLE assertions therefore remain unexecuted here. No permissions were elevated and no extra account was created. The suite has since been revised for the F19.2 decision status guard; see "Update: F19.2 decision status guard" below.

## Changed files

| File | Reason |
| --- | --- |
| `src/lib/requester-notifications.ts` | Browser-safe owner filtering, ID dedupe, status labels, read/acknowledgment service, safe errors. |
| `src/lib/requester-notifications-data.ts` | Existing browser client adapter, owner query, acknowledgment, polling and identity cancellation. |
| `src/lib/requester-notifications.test.ts` | 16 focused F11 service tests. |
| `src/components/RequesterNotifications.tsx` | Accessible bell/popover, unread count, refresh, mark-read, safe links, loading/error/empty feedback. |
| `src/components/AppHeader.tsx` | Replace static notification panel with actual requester alerts. |
| `src/routes/tracking.tsx` | Validate alert link UUID and open only an owned RLS-loaded backend request. |
| `drizzle/migrations/0001_f11_requester_status_notifications.sql` | Private storage, owner policies, status-trigger creation. |
| `drizzle/migrations/0002_f11_restrict_notification_grants.sql` | Explicitly remove inherited broad new-table grants. |
| `drizzle/migrations/meta/_journal.json`, `0001_snapshot.json`, `0002_snapshot.json` | Migration-tool-managed bookkeeping. |
| `src/integrations/supabase/types.ts` | Automatically regenerated by migration tool, not hand-edited. |
| `verification/f11-notifications.sql` | Rollback-only database transition/security/failure integration assertions for privileged CI. Revised for the F19.2 decision status guard (see below). |
| `AGENTS.md` | Record persisted-alert and identity-isolated polling architecture. |
| `roadmap.md` | F11 task completion and blocked integration verification. |
| `docs/F11_Verification_Report.md` | Before/after, changed files, actual results, limitations. |
| `src/routes/index.tsx`, `login.tsx`, `submit.tsx`, `analytics.tsx`, `sla.tsx` | Required leaf metadata completion only (Open Graph type/title/description and Twitter card); no auth or behavior changes. |

## Limitations / release

- Email delivery is not implemented: no verified sender domain exists. Alerts are in-app only; no success claim for email.
- No historical backfill, device-local prototype alerts, browser push, or cross-device offline delivery. Latest 100 alerts are displayed; unread badge counts this window, not an all-history total.
- Notification recording failures preserve requests but may lose an alert; no outbox/retry monitor is provided. 30-second polling is not instantaneous.
- F16 approval-stage/decision infrastructure remains absent on the hosted database; this change does not install it or enable unauthorized reviewer actions. Approval/rejection changes will notify when legitimately persisted by existing authorized paths; full reviewer flow is unverified with this Requester-only session.
- Database changes are applied to the shared preview/published backend now; frontend release still requires publishing.
- No dependency changes, new accounts, role elevation, auth changes, existing security-policy changes, merge, or pull request. The metadata-only edits above are the sole adjacent changes.
- Branch: `feature/f11-requester-status-updates`. Commit hash is reported in the completion message and available via `git log -1` (not embedded before committing).

## Update: F19.2 decision status guard

Migration `supabase/migrations/20261119072711_f19_2_decision_status_guard.sql` now restricts how `financial_requests.status` can change. The original F11 suite moved a request directly through `submitted -> approved`, `approved -> rejected` and `approved -> completed`. Those transitions are no longer valid, and the suite no longer uses them.

### What the guard enforces

- `approved`, `rejected` and `completed` are final for every caller, including the table owner. No status change away from them is allowed, including `approved -> completed`.
- API roles (`anon`, `authenticated`, `service_role`) cannot change status at all, and their inserts must start as `submitted`. Admin and reviewer roles can no longer set status through the request update policy.
- Only the table owner, which is how the `SECURITY DEFINER` workflow functions run, can change status, and only through workflow transitions: `submitted -> under_review`, `under_review -> submitted`, and `submitted`/`under_review` -> `approved`/`rejected`.
- A move to `approved` or `rejected` also needs no active stage and a completed final stage in the request's current workflow revision. In practice decisions come only from `f16_record_approval_decision`, and amendments (`f19_amend_request_workflow`) apply only to `submitted` and `under_review` requests.

### Effect on F11

- Notifications still come only from persisted status transitions. A transition the guard refuses rolls back the request update, so it creates no alert.
- In application use, approval and rejection alerts are generated by `f16_record_approval_decision`, the only application path that records a decision. (A table-owner maintenance session can also make a stage-backed decision directly; the guard allows it.)
- An `under_review` alert is generated on the initial transition to `under_review`, when a multi-stage request advances past its first stage. Later stage advances leave the status `under_review`, so they create no further status-change alert. Amending a pending request still creates alerts as before.
- The F11 trigger, table, policies and grants are unchanged.

### Revised verification approach

`verification/f11-notifications.sql` keeps every original assertion and uses only transitions the workflow itself makes:

- Changed and repeated status: `submitted -> under_review`, then `under_review` again, which adds no alert.
- Failed-update rollback: `under_review -> submitted` inside a rolled-back subtransaction.
- Guard-refused transition (new): `under_review -> completed` is rejected with `check_violation` and creates no alert.
- Injected notification failure: a temporary constraint rejects `submitted` alerts, and the `under_review -> submitted` update still succeeds with the status intact.
- Approval alert (restored): a single-stage request gets its stage from `f16_start_initial_approval_stage` (called as the owner) and is approved through `f16_record_approval_decision` by a reviewer. The suite checks for exactly one `approved` alert to the owner with `previous_status = submitted`. A later `approved -> completed` update is rejected with `check_violation` and adds no alert.
- Rejection alert (restored): the same path with a `reject` decision produces exactly one `rejected` alert with `previous_status = submitted`.
- Grants and multi-identity read and acknowledgment checks are unchanged.

The suite creates its fixture `auth.users` rows (owner, other user, reviewer) and the reviewer's `user_roles` row itself, inside the transaction. It must run as the `financial_requests` table owner, because only the owner may change status directly. It still rolls back completely.

### Prerequisites

The suite requires:

- the F11 notification table and trigger (`drizzle/migrations/0001` and `0002`);
- the F16 approval workflow objects (`approval_stage_tracking`, `user_roles`, `f16_start_initial_approval_stage`, `f16_record_approval_decision`);
- the F19.2 decision status guard, `supabase/migrations/20261119072711_f19_2_decision_status_guard.sql`.

On a database without the guard, the guard-specific assertions fail (`FAIL: guard allowed ...`), because the transitions they expect to be refused succeed. Without the F16 objects, the approval and rejection checks fail. The hosted database lacks the F16 infrastructure (see Limitations), so the suite cannot run there as is.

### Results

#### Earlier run: previous version of the suite

- Local stack (Postgres 17, `supabase/migrations` through `20261119072711`, including the guard). The F11 tables are not installed there, so the run used a wrapper that opened one transaction, applied `drizzle/migrations/0001` and `0002`, inserted the two fixture `auth.users` rows the suite did not create at the time, and then ran the suite with its own `BEGIN;` line removed. The suite's final `ROLLBACK` undid everything, and `public.requester_status_notifications` did not exist afterwards. The command, as recorded in the session log (container name replaced):

  ```sh
  { echo "BEGIN;"
    cat drizzle/migrations/0001_f11_requester_status_notifications.sql; echo; echo ";"
    cat drizzle/migrations/0002_f11_restrict_notification_grants.sql; echo
    echo "INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222') ON CONFLICT DO NOTHING;"
    sed '/^BEGIN;$/d' verification/f11-notifications.sql
  } | docker exec -i <local-db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q
  ```

- That run passed (`F11 integration assertions passed`). The only warning was the suite's own injected notification failure (`SQLSTATE 23514`).
- The same wrapper around the original suite failed at its first direct decision (`submitted -> approved` with no completed stage), with the guard's R4 error, as expected.
- The approval and rejection checks did not exist yet, so this run did not exercise them. At first they were only statically checked.

#### Latest run: revised suite

- Environment: the local Supabase development container `supabase-Financial_Management_System_Group3-database-d733d7b71865`, PostgreSQL 17.11, database `postgres`, connecting as `postgres` (the `financial_requests` table owner) over the local socket. The hosted project was not touched.
- State before the run: `supabase/migrations` through `20261119072711` (13 recorded), the guard trigger enabled, the F11 table absent, and no fixture users, role or requests present.
- The revised suite creates its own fixture users, so the wrapper no longer inserts any. It applied `drizzle/migrations/0001` and `0002` inside one transaction and removed only the suite's initial `BEGIN;` line. The suite's final `ROLLBACK;` was kept. The exact command:

  ```sh
  {
    echo "BEGIN;"
    cat drizzle/migrations/0001_f11_requester_status_notifications.sql
    echo
    echo ";"
    cat drizzle/migrations/0002_f11_restrict_notification_grants.sql
    echo
    sed '/^BEGIN;$/d' verification/f11-notifications.sql
  } | docker exec -i supabase-Financial_Management_System_Group3-database-d733d7b71865 \
      psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X
  ```

- Result: `psql` exited with code 0 and printed `F11 integration assertions passed`. The only warning was the suite's own injected notification failure (`SQLSTATE 23514`). Every check raises an exception on failure and `ON_ERROR_STOP=1` ends the run on the first error, so reaching that notice means every check passed:
  - all original F11 checks, including submission, the initial status change, the unchanged status, the rolled-back update and the injected notification failure;
  - approval produced exactly one `approved` alert to the owner with `previous_status = submitted`;
  - rejection produced exactly one `rejected` alert to the owner with `previous_status = submitted`;
  - the guard refused `under_review -> completed` and `approved -> completed`, with no status change and no additional alert;
  - the permission and per-user visibility checks.
- The approval and rejection checks, previously only statically checked, have now been exercised against PostgreSQL.
- Rollback and restoration: the transaction ended with `ROLLBACK`. Afterwards, read-only checks confirmed:
  - the temporary F11 table, trigger function, trigger and the injected-failure constraint were absent;
  - no fixture users, reviewer role row, requests, stages or fixture workflow events remained;
  - the totals were back exactly at the baseline: 2 auth users, 1 user role, 7 requests, 9 stages and 29 workflow events;
  - the F19.2 guard was still installed and its trigger still enabled, and the migration history was still 13 migrations, latest `20261119072711`.
- The F11 migrations were not permanently installed, the F19.5.4 migrations (`20261119120100_f19_5_4_1_security_hardening` and `20261119130000_f19_5_4_2_event_provenance`) were not applied, and the hosted database was not touched.
- Note on numbering: at the time of this run the F19.5.4.1 migration was numbered `20261119120000`. It was later renumbered to `20261119120100` to avoid a version collision with the upstream F21 migration `20261119120000_f21_rbac_backend_authorization`. Its content did not change.

#### Not yet verified

As recorded before `origin/main` was merged. The first item was later covered in a disposable database; see "Post-integration run" below.

- Not run against the later migrations `20261119120000_f21_rbac_backend_authorization` (upstream F21), `20261119120100_f19_5_4_1_security_hardening` and `20261119130000_f19_5_4_2_event_provenance`, and not yet run on the privileged CI connection.

#### Post-integration run (2026-11-19, HEAD `6d7aaa7`)

This run was made after `origin/main` was merged into `feature/f19-efficiency-analytics` (merge commit `6d7aaa7`). The runs above are unchanged records.

- Environment: a new disposable container, `f11-phase2c-disposable-61325`, started from the local stack's Supabase Postgres image with a random password, no port mapping and no volume, accessed only through `docker exec`, and removed afterwards. The local development database and the hosted database were not connected to.
- Schema: all 16 `supabase/migrations` files applied in version order, each in its own transaction. The last four were `20261119072711_f19_2_decision_status_guard`, `20261119120000_f21_rbac_backend_authorization`, `20261119120100_f19_5_4_1_security_hardening` and `20261119130000_f19_5_4_2_event_provenance`.
- State before the suite: F11 table absent; 0 users, roles, requests, stages and workflow events.
- Command: the wrapper shown under "Latest run", unchanged, aimed at the disposable container. It applied `drizzle/migrations/0001` and `0002` inside the suite's transaction, removed only the suite's initial `BEGIN;` and kept its final `ROLLBACK;`.
- Result: `psql` exited 0 and printed `F11 integration assertions passed`, so none of the suite's 16 failure checks fired, including the approval, rejection and guard checks. The only warning was the suite's own injected notification failure (`SQLSTATE 23514`).
- After the rollback: the F11 table, trigger function and trigger were absent, and no users, roles, requests, stages, workflow events or fixture users remained (all 0, as before the run).

This shows the suite passes with F19.2, F21, F19.5.4.1 and F19.5.4.2 applied in that order. It does not cover the hosted database, which lacked the F16 objects the suite needs when last checked (see Limitations), or the privileged CI connection, where the suite has still not been run.