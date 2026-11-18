# Issue #9 — F9: Automatic requester status tracking

## Scope and approved alternative

Branch: `feature/f9-real-time-status-tracking`. No merge or pull request created.

The read-only publication inspection returned no `public.financial_requests` entry in `supabase_realtime`. Consequently, PostgreSQL change subscriptions would not deliver this table's updates. Enabling the publication would require a database change outside the original permission boundary. The user explicitly chose **Automatic checks**, every 30 seconds and on reconnect, with no database/security changes.

This implementation is polling, not instantaneous WebSocket Realtime. It is ready for a pull request under that approved scope, with reviewer-driven persistence verification still outstanding.

## Before / after

- Before: My Requests loaded once; later persisted status changes required a page refresh. An open detail retained its original request snapshot.
- After: visible My Requests checks authorized persisted rows immediately, every 30 seconds, on focus, on becoming visible, and on reconnect. Cards, workflow trackers, counts, sections, and open details read the refreshed rows without resetting search/status selection or replacing the page with a loading screen.
- Offline and failed-check feedback is explicit. Offline rows can remain visible with a stale-status warning; failed backend reads do not retain old persisted rows as a successful current result. Access errors keep the existing restricted notice rather than masquerading as an empty dataset.
- Hidden pages pause polling. Navigation, identity changes, MFA-required state, and sign-out clean up the scheduler. Obsolete async results cannot publish data to a later identity; financial request fetches are aborted on cleanup/replacement.
- Requester reads add `user_id = current user` in addition to existing RLS. Other request views remain manually refreshed, preserving F12/F23 behavior. Owner-scoped prototype rows retain their local-only label; polling never converts them into persisted records.
- No notification writes, new subscriptions, email delivery, or changes to F11's private notification polling.

## Exact files changed

| File | Purpose |
| --- | --- |
| `src/lib/request-status-sync.ts` | Browser-safe read-only scheduler, fixed interval, offline/visibility/reconnection handling, overlap prevention, cleanup. |
| `src/lib/request-status-sync.test.ts` | Twelve focused tests for lifecycle, changed statuses, errors/recovery, identity isolation, ownership, local-only data, and composed list rules. |
| `src/lib/requests-data.ts` | Opt-in automatic checking; identity-scoped cancellable reads; background refresh; hide data for wrong identity/MFA; preserve existing row mapping/access classification. |
| `src/routes/tracking.tsx` | Enable checks only for tracking, show connection/check state, keep open detail synchronized with current authorized rows. |
| `AGENTS.md` | Record scheduler/identity architecture and prohibition on F11 writes. |
| `roadmap.md` | Track F9 scope, approved alternative, completion and verification. |
| `docs/F9_Verification_Report.md` | This report. |

No authentication, database schema, migrations, policies, generated clients/types, dependencies, or submission storage logic changed. Issues #127 and #71 were not modified. No unrelated feature work.

## Actual verification

- Focused run: **78/78** tests passed across F9, F12, F11, and F23 export guards.
- Complete run: **207/207**, **14/14** files passed using `bunx vitest run` (includes all CSV/download tests).
- Platform automatic TypeScript/production validation: latest entry `2026-11-18T06:52:54Z`: **build OK**. An initial new-test type error was corrected before final verification. Builds/typechecks were not manually rerun because the platform owns these checks.
- Signed-in Playwright check used the existing Requester session, no new accounts or elevated roles. Real persisted owner request `FR-2026-HWJCR8` loaded from the backend. All returned request rows belonged to the signed-in owner.
- A controlled **read-response-only** `approved` status change appeared automatically after the interval in the card, workflow, count, and already-open detail; the request-number search stayed selected. This did not write a database status or fabricate notifications.
- Offline state displayed a stale-status warning. Reconnection initiated a successful read automatically.
- Controlled 403/42501 read failure displayed the restricted notice, removed persisted rows/details, preserved controls with zero counts, and recovered on the next successful check.
- After navigation to `/requests`, no tracking reads occurred during a 31-second observation. After sign-out, no financial-request reads occurred during another 31 seconds.
- Desktop 1280×1800 and mobile 390×844 were inspected; mobile page had no horizontal document overflow. The pre-existing mobile detail workflow remains horizontally clipped/scrollable; no unrelated layout changes were made.
- Browser runtime errors: **none**. Evidence/script retained in `/tmp/browser/f9/` for this sandbox session, not as permanent repository artifacts.
- All content routes were inspected for existing unique title/description/OG/card metadata; no metadata changes were necessary.

## Limitations / unverified scenarios

- Genuine reviewer/admin status UPDATE → persisted read-back was **not tested**: no role elevation or new account creation was performed. Real owner reads plus controlled response changes verify the UI refresh path, not a production reviewer transition or F11 delivery for that transition.
- Hosted/published-site verification, WebSocket subscriptions, multi-tab identity switches, and Safari/iOS remain unverified. Scheduler identity cleanup is automated-test covered; existing session sign-out/navigation cleanup is browser verified.
- Polling can lag by 30 seconds plus read duration; background tabs pause it. Existing optional approval-stage storage remains absent and logged as a warning; its absence does not block status reads.
- Existing prototype fallback storage remains unchanged (Issue #127 out of scope). A read failure does not turn local records into verified database records.
- F11 and F23 passed regression tests; no duplicate-notification integration test involving a real reviewer mutation was possible.

## Commit

All seven files are committed together on the F9 branch. The final response supplies the resulting short commit hash; `git log -1 --oneline` identifies the full repository commit without embedding a self-referential hash in this file.