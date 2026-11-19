# Issue #12 — Filtering, Sorting & Searching

## Result

Implemented on `feature/f12-filtering-sorting`; no merge into main, no account creation, and no role elevation.

- `/requests` supports **Newest First**, **Oldest First**, **Amount High to Low**, and **Amount Low to High**.
- Sorting composes with title/request-number/requester-email/department search, status filters, and funding filters. Search now ignores surrounding whitespace.
- Existing Pending and Submitted & Decided sections are preserved; sorting applies within each displayed section. Full submission timestamps are retained for same-day ordering, without changing displayed dates.
- `/tracking` keeps its title/number search, status chips, counts, request cards, detail dialog, and workflow tracker.
- Permission errors show an **Access restricted** notice rather than an empty-list message. Availability failures get a different notice. Owned prototype rows can still display with the notice.
- Locally saved requests are always restricted to their signed-in owner, even on All Requests. My Requests uses owner IDs rather than an email fallback.

## Permission-error investigation

Hosted policies still called `is_admin_or_reviewer` and `has_role`, but an earlier migration revoked authenticated execution of both functions. This caused PostgreSQL error `42501` during RLS policy evaluation, not an absence of requests.

The F12 migration restores authenticated execution only after binding both functions to `auth.uid()`. A caller cannot check another user's roles. Anonymous execution remains revoked. Table privileges, role assignments, authentication gates, and RLS policies were not widened or disabled.

This migration was applied to the shared hosted backend. The code remains on the feature branch, but database permission repairs are shared by preview and published apps.

## Verification results

- `bunx vitest run`: **161/161 tests passed**, across **10/10 test files**.
- New F12 tests: **34/34 passed** (search scopes, every status/funding value, four sorting modes, combined filters, timestamp ties, access classification, owner isolation, and empty/error/loading states).
- Targeted F12/backend-error/submission regressions: **74/74 passed** across four files.
- Automatic TypeScript and production build checks: **build OK**, latest observed at `2026-11-18T05:06:17Z`. Checks were performed by the platform harness, not a separate manual build command.
- Five read-only SQL security checks: **5/5 passed** — authenticated execution allowed, anonymous execution denied, and RLS retained on all five existing application tables.
- Real existing Requester session: reviewer/admin checks return **false**, and a foreign-identity reviewer check returns **false**.
- Browser verification using that existing session: all four sort choices selectable; combined search/status/funding controls report zero matching requests correctly; My Requests search and chips remain available with zero counts.
- A browser-intercepted `403 / 42501` read response displayed the restricted notice and suppressed the misleading empty state. This changed no permissions, identities, database rows, or tokens.
- Desktop and 390px mobile request pages checked: no horizontal page overflow. No browser runtime errors observed.

## Exact files changed

| File | Reason |
| --- | --- |
| `src/routes/requests.tsx` | Composed sorting, accessible control labels, shared access notice, preserved sections/details, page metadata. |
| `src/routes/tracking.tsx` | Reuse search rules; owner-scoped reads; distinguish restricted/unavailable from empty; preserve UI and metadata. |
| `src/lib/request-list.ts` | Pure filtering, sorting, error classification, owner visibility, and list-state logic. |
| `src/lib/request-list.test.ts` | 34 concrete F12 regression tests. |
| `src/components/RequestReadNotice.tsx` | Shared accessible permission/availability notice. |
| `src/lib/requests-data.ts` | Preserve full timestamps; classify read errors; scope local rows; expose read issue; clear stale results. |
| `src/lib/approval-stage-client.ts` | Typed view of the existing authenticated browser client for an optional F16 table missing from generated hosted types. No new client/session. |
| `src/routes/sla.tsx` | Minimal import/query-client substitution to fix its pre-existing TypeScript error for that same optional table; no workflow/UI behavior change. |
| `drizzle/migrations/0000_f12_restore_self_scoped_authorization_helpers.sql` | Self-scoped helper execution repair. |
| `drizzle/migrations/meta/0000_snapshot.json` | Migration-tool-generated snapshot. |
| `drizzle/migrations/meta/_journal.json` | Migration-tool-generated journal. |
| `drizzle/schema.ts` | Migration-tool-generated placeholder. |
| `drizzle.config.ts` | Migration-tool-generated configuration. |
| `package.json` | Migration tool added development tooling (`drizzle-kit`, `drizzle-orm`, `postgres`); no application dependency added. |
| `bun.lockb` | Migration-tool dependency lock changes. |
| `verification/f12-security.sql` | Repeatable read-only grant/RLS checks. |
| `AGENTS.md` | Implementation constraints for request rules, access handling, and optional stage queries. |
| `roadmap.md` | F12 task checklist and verification limitations. |
| `docs/F12_Verification_Report.md` | This report. |

Generated application types were refreshed by the migration tool but have no net change. Authentication configuration, request submission logic, detail-dialog code, workflow-tracker code, and application styling files were not changed.

## Remaining limitations

- The current Requester session returned **zero backend requests**, and a fresh browser cannot inherit device-local prototype rows from the user's preview. Populated ordering/filtering and cross-owner isolation are covered by automated fixtures, not a live populated browser list. No sample requests were inserted.
- All Requests is reachable by the Requester session but RLS only permits owned backend rows; reviewers/admins/leadership can read broader sets according to existing policies. Elevated-role browser checks were deliberately not performed.
- The hosted backend does not contain the optional F16 approval-stage table referenced by existing feature-branch code. Existing non-blocking request-stage handling and SLA error behavior are preserved; installing unrelated F16 migrations is outside F12.
- UI access-failure testing used a controlled denied read response; it is not a full two-account RLS test. Actual Requester RPC checks and grant/RLS inspection were also verified without elevated access.
- No GitHub issue-state update or merge was performed.

## Post-integration security checks (2026-11-19)

The results above are the original record, including the five hosted read-only SQL checks. This section adds a later run in a disposable database, after `origin/main` was merged into `feature/f19-efficiency-analytics` (HEAD `6d7aaa7`). It did not touch the hosted backend, and it does not repeat the browser, session or vitest checks above.

- Environment: a new disposable container, `f12-phase2d-disposable-61577`, started from the local stack's Supabase Postgres image with a random password, no port mapping and no volume, accessed only through `docker exec`, and removed afterwards. The local development database was not connected to.
- Script: the unmodified `verification/f12-security.sql`, run as `postgres`.
- Variant A, all 16 `supabase/migrations` files in version order (through `20261119120000_f21_rbac_backend_authorization`, `20261119120100_f19_5_4_1_security_hardening` and `20261119130000_f19_5_4_2_event_provenance`): **5/5 passed**.
- Variant B, the same database after also applying `drizzle/migrations/0000_f12_restore_self_scoped_authorization_helpers`, `0001` and `0002` in journal order: **5/5 passed**.
- The five checks, passed in both variants: authenticated can execute role checks; authenticated can execute reviewer checks; anonymous cannot execute role checks; anonymous cannot execute reviewer checks; request and role tables retain row-level security.

In Variant A the F12 drizzle migration was not applied, yet authenticated execution was allowed. This suggests a `supabase/migrations` file, probably upstream F21, now grants it. That is an inference; no run isolated which migration grants it. These runs check grants and RLS settings on a fresh schema; they do not show the hosted backend's current state.