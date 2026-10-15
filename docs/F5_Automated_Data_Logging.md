# F5: Automated Data Logging

## Overview

Before F5, logging depended on the app remembering to write a `workflow_events` row, and only one place did. Errors were swallowed by bare `catch {}` blocks (DEBT_AND_RISK Items 7 and 13), so failures left no trace.

F5 adds two kinds of automatic logging:

1. **Data logging in the database.** Triggers record every request change and every attachment change in `workflow_events`, no matter what made the change (app, API, SQL editor).
2. **Application logging.** A structured logger replaces silent catch blocks in the submit flow, data loading, and the F7 server function.

F13 (Audit-Ready Activity Logs) and F20 (Immutable Audit Logs) can build on these events.

---

## What We Built

### 1. Database triggers

**Migration:** `supabase/migrations/20261015130000_f5_automated_data_logging.sql`

| Trigger | Table | Fires on | Event types |
|---|---|---|---|
| `f5_log_financial_request` | `financial_requests` | INSERT, UPDATE | `request_created`, `status_changed`, `routing_changed`, `request_updated` |
| `f5_log_request_attachment` | `request_attachments` | INSERT, DELETE | `attachment_added`, `attachment_removed` |

Every event has:
- `actor_user_id` from `auth.uid()` (who made the change)
- a readable `message`, e.g. *Status changed from submitted to under_review.*
- `metadata.source = "db_trigger"` so these can be told apart from app-written events

**What counts as an edit.** `request_updated` lists each changed field with `from` and `to`:

```json
{ "source": "db_trigger", "changes": { "amount": { "from": 1234.5, "to": 2000 }, "description": { "changed": true } } }
```

Tracked fields: title, requester email, department, funding source, amount, needed-by, priority, description, grant number, PI, program. The description is only marked as changed, not copied, to keep the log small. `updated_at`, `metadata`, and `workflow_triggered_at` are bookkeeping and are not logged as edits.

**Security.** The trigger functions are `SECURITY DEFINER` so they can write past the RLS insert policy on `workflow_events`, and `EXECUTE` is revoked from `anon` and `authenticated` so they cannot be called directly. They only insert.

**Indexes** on `workflow_events (request_id, created_at DESC)` and `(event_type)` keep the activity list and future reports fast.

### 2. Application logger

**Location:** `src/lib/logger.ts`

```ts
logger.error("attachment.upload_failed", { requestId, fileName, error });
```

- Levels: `debug` (dev only), `info`, `warn`, `error`
- Output goes to the browser console, or to Cloudflare Worker logs for server code
- Errors and Supabase error objects are converted to `{ code, message, details, hint }`
- Keys that look sensitive (`token`, `password`, `secret`, `authorization`, `signature`, flow URL) are replaced with `[redacted]`
- Last 100 entries are kept in memory (`getRecentLogs()`)
- `addLogSink()` lets the team plug in Sentry or similar later without changing call sites

**Events now logged:**

| Event | Where |
|---|---|
| `request.submitted` | successful submit |
| `request.rejected_by_database` | F22 database gateway rejected the row |
| `request.insert_failed_prototype_fallback` | backend unavailable, saved locally |
| `request.submit_failed` | unexpected submit error |
| `attachment.upload_failed`, `attachment.link_failed`, `attachment.storage_unavailable` | attachment steps |
| `workflow.started`, `workflow.start_failed`, `workflow.call_failed` | F7 call from the browser |
| `workflow.initialized`, `workflow.flow_rejected`, `workflow.event_write_failed` | F7 server function |
| `requests.load_failed`, `requests.load_crashed`, `prototype_store.corrupt` | request list loading |
| `activity.load_failed` | activity list |

### 3. Activity list

The request detail dialog now has an **Activity** section showing every event for that request in order, read through `useRequestActivity()` in `src/lib/activity-data.ts`. RLS limits it to requests the user can already see.

---

## Files Changed

| File | Change |
|---|---|
| `supabase/migrations/20261015130000_f5_automated_data_logging.sql` | New. Triggers and indexes |
| `src/lib/logger.ts` | New. Structured logger |
| `src/lib/activity-data.ts` | New. `useRequestActivity()` hook |
| `src/components/RequestDetailDialog.tsx` | Activity section |
| `src/routes/submit.tsx` | Logs each failure path |
| `src/lib/requests-data.ts` | Logs load errors and corrupt local data |
| `src/lib/workflow/initialize-workflow.ts` | Logs workflow outcome and event write failures |

---

## How to Test

1. Apply the migration.
2. Submit a request with one attachment. Open it from **My Requests**. Activity shows *Request … created*, *Attached …*, and the F7 workflow event.
3. In the SQL editor, run `UPDATE financial_requests SET status = 'under_review' WHERE request_number = '<id>';`. Reopen the dialog: *Status changed from submitted to under_review.*
4. Change amount the same way: *Updated amount.* with from/to in metadata.
5. Open devtools, turn off the network, submit. The console shows `[finreq] request.insert_failed_prototype_fallback` with the error.
