# F19.5.4 – Security Hardening

**Migrations:**

- `supabase/migrations/20261119120000_f19_5_4_1_security_hardening.sql` (F19.5.4.1: S1, S2, S3)
- `supabase/migrations/20261119130000_f19_5_4_2_event_provenance.sql` (F19.5.4.2: event provenance, default DELETE)

**Source findings:** F19.5.4 historical workflow and security audit
**Not included:** S4 (see section 7)

## 1. S1: `financial_requests.created_at` is database-controlled and immutable

Before F19.5.4.1, the F4 trigger filled `created_at` only when the client sent none. API roles held column INSERT and UPDATE privileges on it, and no trigger protected it on update. The UPDATE policy also let admin, reviewer and leadership users change it on any request, including decided ones, and F5 did not log the change. A requester could backdate a request on insert or while it was `submitted`, and privileged users could move a decided request between reporting periods. That affected Request Volume and Request Turnaround Time.

Two triggers enforce the rule for every role, every status and every write path, including the table owner and the SECURITY DEFINER workflow functions:

| Trigger                           | Fires                   | Position                                                                                  | Effect                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f19_assign_request_created_at`   | BEFORE INSERT           | First BEFORE trigger on the table                                                         | Sets `created_at := now()`, the column default. A client-supplied value, including `infinity`, years after 9999 or BC dates, is replaced. F4 then derives `request_number` and the fiscal metadata from the authoritative value. |
| `zz_f19_guard_request_created_at` | BEFORE INSERT OR UPDATE | After every trigger that modifies the row (only `zz_f19_guard_request_status` follows it) | Checks the final row: on INSERT `created_at` must equal `now()`; on UPDATE it must be unchanged. Otherwise it raises `check_violation`.                                                                                          |

- The guard checks the final row, so a later trigger cannot change `created_at` unnoticed.
- There is no bypass: no session setting, role test or SECURITY DEFINER path.
- Existing rows are not modified. The migration contains no data change, and the disposable-database runner checks that every request's `(id, created_at)` is identical before and after it.
- Updates that do not change `created_at` work as before, including setting it to its current value.

**Exceptional corrections.** The application has no way to correct a creation timestamp, and workflow events are never used for it. A correction requires a separate, controlled and auditable process run by the table owner: a dedicated, reviewed migration that records the request, the old and new values and the reason, and disables and re-enables `zz_f19_guard_request_created_at` within the same transaction.

**Catalog (planned follow-up).** The metrics catalog is not changed by these migrations. A follow-up catalog commit will replace the known limitation `created_at_client_writable` with `created_at_unverified_before_hardening` (not resolvable) and bump the catalog to version `2026-11-19.2`. With that change, `created_at` written after F19.5.4.1 is treated as trusted, and only values stored before it remain unverifiable. Until it lands, the committed catalog still lists `created_at_client_writable`.

## 2. S2/S3: privileges on the F19 tables

Tables: `financial_requests`, `approval_stage_tracking`, `workflow_events`, `request_workflow_amendments`, `workflow_initialization_state` (owner `postgres`).

The privileges came from the default ACL of role `postgres` in schema `public`, which grants every table privilege to `anon`, `authenticated` and `service_role`. F19.2 later revoked INSERT, UPDATE and DELETE on three tables from `authenticated` only.

- **S2:** TRUNCATE, TRIGGER, REFERENCES and MAINTAIN (PostgreSQL 17+) are revoked from `anon` and `authenticated` on the five tables. RLS never applies to TRUNCATE.
- **S3:** INSERT, UPDATE and DELETE are revoked from `anon` on the five tables, which have no `anon` policies.
- **`authenticated` DML:** the role keeps exactly the commands that have an RLS policy and an application write path:
  - `financial_requests` INSERT: submission (`browser-submission.ts`, `request-submission.ts`).
  - `financial_requests` UPDATE: owner edits while `submitted`, the routing write in `initialize-workflow.ts`, and reviewer or admin updates.
  - `workflow_events` INSERT: the existing owner and reviewer policies, now subject to the provenance guard (section 3).
- **Revoked from `authenticated`:** DELETE on `financial_requests` and UPDATE/DELETE on `workflow_events`. Neither has a policy or a caller. Stage, amendment and initialization-state writes go only through SECURITY DEFINER functions.
- **Unchanged:** SELECT for every role, and every `service_role` privilege.

## 3. Workflow event provenance (F19.5.4.2)

### 3.1 Call-site audit

| Writer                                          | Kind                       | Event types                                                               | `source` in metadata          | Actor        |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------- | ----------------------------- | ------------ |
| `f5_log_financial_request`                      | trigger, SECURITY DEFINER  | `request_created`, `status_changed`, `routing_changed`, `request_updated` | `db_trigger`                  | `auth.uid()` |
| `f5_log_request_attachment`                     | trigger, SECURITY DEFINER  | `attachment_added`, `attachment_removed`                                  | `db_trigger`                  | `auth.uid()` |
| `f6_add_link` (from `f6_link_related_requests`) | function, SECURITY DEFINER | `record_linked`                                                           | `db_trigger`                  | none         |
| `f16_record_approval_decision`                  | RPC, SECURITY DEFINER      | `approval_approved`, `approval_rejected`                                  | **none**                      | `auth.uid()` |
| `f19_complete_workflow_initialization`          | RPC, SECURITY DEFINER      | `workflow_initialized`, `workflow_failed`                                 | `f19_workflow_initialization` | `auth.uid()` |
| `f19_amend_request_workflow`                    | RPC, SECURITY DEFINER      | `request_amended`                                                         | `f19_amend_request_workflow`  | `auth.uid()` |
| Application code (`src/`)                       | none                       | none: no call site inserts into `workflow_events`                         |                               |              |

All six database writers are owned by `postgres`. Before F19.5.4.2:

- The RLS INSERT policies let a requester (own requests, with `actor_user_id = auth.uid()`) and any admin, reviewer or leadership user (any request, **any** `actor_user_id`) insert any `event_type`, any `metadata` (including `"source": "db_trigger"`) and any `created_at`.
- Decision events carry no `source`, so a forged `approval_approved` was indistinguishable from a real one.
- `anon` had an INSERT grant but no policy. `service_role` bypasses RLS.

`f19_complete_workflow_initialization` merges the caller's `_event_metadata` and uses the caller's `_event_message`, but always overwrites `source`. Its events are database-generated, though those two fields are caller-supplied content.

### 3.2 Design

`f19_guard_workflow_event_provenance` is a BEFORE INSERT trigger on `workflow_events` (SECURITY INVOKER). It uses the trust anchor of `zz_f19_guard_request_status`: an insert is database-generated only when `current_user` is the table owner, read from `pg_class`. That holds inside the SECURITY DEFINER writers above. It never holds for `anon`, `authenticated` or `service_role`, and no session setting is consulted.

- **Owner context:** unchanged. Every trigger and RPC writes exactly what it wrote before.
- **Any other caller** writes a client event:
  - A reserved event type (the 12 types above) is rejected (`42501`).
  - `metadata` must be a JSON object (`23514`), and a `source` other than `client` is rejected (`42501`); the stored event always has `"source": "client"`.
  - `actor_user_id` must be empty or `auth.uid()` (`42501`) and is set to `auth.uid()`.
  - `created_at` is set to `now()`.
- The existing RLS policies still decide who may append an event to which request; they are unchanged.

A static test (`src/lib/workflow/event-provenance-migration.test.ts`) parses every `INSERT INTO public.workflow_events` in the migration history and requires the reserved list to equal the set of event types the database writes, so a new database event type cannot be added without reserving it.

**Why this design.** It is the smallest change that makes forged database events impossible while keeping every existing path:

- **Revoking `authenticated` INSERT and dropping the two policies** would also work, because no application path uses them. It would, however, remove a capability the F16 policy migration deliberately recreated, which changes workflow behaviour beyond provenance.
- **A new `origin` column** would give the clearest provenance signal, but it changes the table shape and leaves the generated Supabase types stale (AGENTS.md: generated schema files stay untouched).
- **Adding a `source` to decision events** would mean redefining `f16_record_approval_decision`, a workflow RPC this checkpoint must not change. Reserving the event types covers those events instead.

**Not resolved.**

- Events stored before F19.5.4.2 cannot be shown to be database-generated. A forged historical event looks identical to a real one, and the runner seeds one to demonstrate this.
- Client events remain client-authored content, now clearly marked `source: client`.
- `service_role` still holds UPDATE and DELETE on `workflow_events`.

## 4. Default privileges (F19.5.4.1 and F19.5.4.2)

Only `FOR ROLE postgres IN SCHEMA public` is changed; `supabase_admin` and other schemas keep the platform defaults.

- F19.5.4.1 removed TRUNCATE, TRIGGER, REFERENCES and MAINTAIN from `anon` and `authenticated`, and INSERT, UPDATE and DELETE from `anon`.
- F19.5.4.2 removes DELETE from `authenticated`. No application path deletes from a future table. The only application DELETE target, `request_attachments` (attachment removal policy), is an existing table and keeps its grant. A future table that needs DELETE must grant it in the migration that creates it.

## 5. Privilege matrix

"All 8" means SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN.

| Object                                   | Role            | Before F19.5.4.1                                | After F19.5.4.2                 |
| ---------------------------------------- | --------------- | ----------------------------------------------- | ------------------------------- |
| all five F19 tables                      | `anon`          | all 8                                           | SELECT                          |
| `financial_requests`                     | `authenticated` | all 8                                           | SELECT, INSERT, UPDATE          |
| `workflow_events`                        | `authenticated` | all 8                                           | SELECT, INSERT (guarded)        |
| stages, amendments, init state           | `authenticated` | SELECT, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN | SELECT                          |
| all five F19 tables                      | `service_role`  | all 8                                           | all 8 (unchanged)               |
| default ACL `postgres` in `public`       | `anon`          | all 8                                           | SELECT                          |
| default ACL `postgres` in `public`       | `authenticated` | all 8                                           | SELECT, INSERT, UPDATE          |
| default ACL `postgres` in `public`       | `service_role`  | all 8                                           | all 8 (unchanged)               |
| default ACL `supabase_admin` in `public` | all API roles   | all 8                                           | all 8 (unchanged, out of scope) |

## 6. Verification

Static checks for these migrations:

```sh
npx vitest run src/lib/workflow/security-hardening-migration.test.ts src/lib/workflow/event-provenance-migration.test.ts src/lib/workflow/decision-status-guard-migration.test.ts
```

The F19.2 guard test is included because it scans every migration's BEFORE triggers on `financial_requests` and requires `zz_f19_guard_request_status` to fire last.

The planned catalog follow-up (section 1) will add a test to `src/lib/efficiency-metrics.test.ts` that checks the new limitation against this migration's `created_at` triggers. That check is not part of this change. Once the follow-up lands, run it with `npx vitest run src/lib/efficiency-metrics.test.ts`.

Database behaviour, in a **disposable** container started from the local stack's Postgres image. The script never connects to the local stack:

```sh
bash verification/f19_5_4_1_disposable_db.sh "$(docker inspect <local-db-container> --format '{{.Image}}')"
```

The runner:

1. Adds a minimal storage-api stand-in and applies the earlier migrations.
2. Seeds history: requests with fixed `created_at` values, and an event forged through the old owner policy.
3. Applies F19.5.4.1 and F19.5.4.2 and checks that requests and events are unchanged.
4. Runs both regression scripts.
5. Re-runs the F19.2 verification scripts.

Both regression scripts refuse to run unless called with `-v disposable=1`.

- `verification/f19_5_4_1_security_hardening.sql`: trigger order; the privilege matrix and default privileges (final schema); denied writes, TRUNCATE, CREATE TRIGGER and LOCK; `created_at` assigned on insert and immutable for every role and status; application paths; historical timestamps; future tables.
- `verification/f19_5_4_2_event_provenance.sql`:
  - Structure and default privileges, including a future table without DELETE and the kept `request_attachments` DELETE.
  - Rejected impersonation by requester, reviewer, admin and `service_role`: every reserved type, every database source, non-object metadata and forged actors. `anon` and other requesters are also refused.
  - Accepted client events with database-derived actor, time and source.
  - Every database event path still writes its event unchanged, all 12 types included.
  - The forged historical event is preserved.

## 7. S4: separate follow-up (not changed)

`f19_guard_request_workflow_fields` allows protected-field and routing changes when the custom settings `app.f19_trusted_workflow_write` or `app.f19_allow_amendment_write` are `on`. Any role can set these settings, and the F19.2 decision-status-guard migration itself treats such settings as untrusted. PostgREST clients cannot issue `SET`, so no API path is known. Replacing this trust mechanism, for example with the `current_user`-is-table-owner test used by `zz_f19_guard_request_status` and the event provenance guard, needs its own design review. It changes how the amendment and initialization functions authorise their writes.
