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
- Full `verification/f11-notifications.sql` integration suite is retained for privileged CI. Execution was attempted but **blocked at request UPDATE**: managed sandbox `sandbox_exec` lacks UPDATE on `financial_requests`. Full actual changed-status, repeated-status, failed-update rollback, injected notification failure, and multi-identity SET ROLE assertions therefore remain unexecuted here. No permissions were elevated and no extra account was created.

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
| `verification/f11-notifications.sql` | Rollback-only database transition/security/failure integration assertions for privileged CI. |
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