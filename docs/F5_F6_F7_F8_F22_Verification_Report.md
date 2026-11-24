# Verification Report: F5.4, F6.4, F7.4, F8.4, F22.4

Covers issues #260, #264, #268, #272, #276 and their sub-issues. Each "How to Test" step from the feature docs is now an automated check, so the team can rerun them.

## How it was run

- **Database checks** (`verification/f5-f6-f22-db-verification.sql`): all 12 migrations applied in order to a fresh local PostgreSQL 16 database, with a small stub for Supabase's `auth` and `storage` schemas. The script acts as signed-in users through `auth.uid()` and the `authenticated` role, so RLS policies and triggers run the same way they do through PostgREST.
- **App checks** (Vitest): new tests for routing, validation gateways, and workflow initialization, plus one added submission test.
- Full suite: **290/290 passed** in 22 files (257 before). `tsc --noEmit`, `eslint`, and `npm run build` pass.

Rerun the database checks on a disposable database with migrations applied:

```
psql -v ON_ERROR_STOP=1 -f verification/f5-f6-f22-db-verification.sql
```

## Results

| Issue | Check | Result | How |
|---|---|---|---|
| #281 F5.4.1 | Request created, attachment added and removed are logged; owner can read them | Pass | DB |
| #282 F5.4.2 | Status change logs "Status changed from submitted to under_review." with from/to and reviewer as actor; amount change logs from 500 to 750 | Pass | DB |
| #283 F5.4.3 | Failed insert logs `request.insert_failed_prototype_fallback` at error level with the error details | Pass | Vitest |
| #294 F6.4.1 | `NSF-2041` and `nsf-2041` link as same grant both ways; matching department requests link as possible duplicate; `record_linked` events written | Pass | DB |
| #295 F6.4.2 | User B cannot see links to user A's requests (2 such links exist); reviewer can | Pass | DB |
| #296 F6.4.3 | Deleting a user with requests fails on `financial_requests_user_id_fkey`; a request with 2 attachments returns 2 | Pass | DB |
| #308 F7.4.1 | No flow URL: mode `simulated`, no HTTP call, `workflow_initialized` event, `workflow_triggered_at` set, routing saved | Pass | Vitest |
| #309 F7.4.2 | Flow accepts (mocked HTTP 202): signed payload with idempotency key, `runId` stored | Pass with mock | Vitest |
| #310 F7.4.3 | HTTP 400 is not retried, writes `workflow_failed`, leaves `workflow_triggered_at` null; second call writes no new event and does not call the flow | Pass | Vitest |
| #320 F8.4.1 | Base queue for Department, Research, University | Pass | Vitest |
| #321 F8.4.2 | Every amount row in the doc table, plus one cent below each threshold | Pass | Vitest |
| #322 F8.4.3 | University $6,000 High is expedited; Medium due in 2 days is expedited; 3-day window is inclusive | Pass | Vitest |
| #333 F22.4.1 | Gmail email, `10.555`, Research with no grant, University with no program each show the error on the right field | Pass | Vitest |
| #334 F22.4.2 | Direct inserts with gmail email, zero amount, Research with no grant, University with no program are rejected by the named CHECK | Pass, with finding below | DB |
| #335 F22.4.3 | Stale grant, PI, and program are null after switching to Department, in both the payload gateway and the database trigger | Pass | Vitest + DB |

## Findings

1. **Amount precision CHECK cannot fire (F22).** `amount` is `numeric(12,2)`, so Postgres rounds `10.555` to `10.56` before `financial_requests_amount_precision` runs. A direct insert is stored as `10.56` instead of being rejected. The form and payload gateways still reject 3 decimals, so normal use is unaffected. Fixing this would need the column type or a `BEFORE INSERT` check on the raw input; the test records current behavior so a fix shows up as a change.
2. **F7.4.2 still needs one live run.** The success path is verified with a mocked HTTP response. Confirming the real flow's run history needs someone with access to the Power Automate flow and its URL.
3. **F5 doc step 5 will change with PR #173.** That PR renames the event to `request.insert_failed`. Whoever merges it should update the F5.4.3 test in `submission-service.test.ts` to the new name.

## Code change for testability

`initializeWorkflow` was a single `createServerFn` handler, and the TanStack build step replaces the handler with an RPC stub under Vitest, so its logic could not be tested. The body moved unchanged into `src/lib/workflow/run-initialize-workflow.ts` as `runInitializeWorkflow(db, userId, requestId)`. `initialize-workflow.ts` still exports `initializeWorkflow` with the same auth middleware, input validation, and types, so no callers changed.

## Not covered

- Visual checks in the browser (sidebar chain preview, success screen labels, Activity and Linked Records sections in the request dialog). The data behind each one is verified above.
- The hosted Supabase project. Results come from the same migrations on a local database.

## Files

| File | Change |
|---|---|
| `verification/f5-f6-f22-db-verification.sql` | New. Database checks for F5.4, F6.4, F22.4 |
| `src/lib/routing/engine.test.ts` | New. F8.4 tests |
| `src/lib/validation/gateways.test.ts` | New. F22.4.1 and F22.4.3 tests |
| `src/lib/workflow/initialize-workflow.test.ts` | New. F7.4 tests |
| `src/lib/workflow/run-initialize-workflow.ts` | New. Workflow logic moved out of the server function |
| `src/lib/workflow/initialize-workflow.ts` | Now a thin server-function wrapper |
| `src/lib/requests/submission-service.test.ts` | Added F5.4.3 test |
| `docs/F5_F6_F7_F8_F22_Verification_Report.md` | This report |
