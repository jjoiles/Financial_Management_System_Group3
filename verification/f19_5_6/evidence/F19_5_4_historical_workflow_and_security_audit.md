# F19.5.4: Historical workflow and security audit

Scope: local Supabase database (container `supabase-Financial_Management_System_Group3-database-…`, PostgreSQL 17.11, 13 migrations applied, latest `20261119072711_f19_2_decision_status_guard`) and the repository at branch `feature/f19-efficiency-analytics`. Every query ran in a forced read-only session (`default_transaction_read_only = on`, `READ ONLY` transactions ending in `ROLLBACK`). User IDs are shown as 8-character prefixes; no personal data is reproduced.

Evidence files (same folder): `q_catalog.sql`/`out_catalog.txt`, `q_created_at.sql`/`out_created_at.txt`, `q_data.sql`/`out_data.txt`, `parser/result.txt`.

## 1. Executive summary

- **The current 7 requests and 9 stages are consistent**, but they are all F19.2 regression fixtures written in one short window *after* the F19.2 integrity migration and *before* the decision status guard existed (transaction IDs 1238–1249, against 1237 for the integrity objects and 1277 for the guard trigger). No row in the three tables has changed since the guard was installed. The data says nothing about production-style history.
- **`created_at` is not trusted.** API roles hold column-level INSERT and UPDATE on it, no trigger protects it on UPDATE, F5 does not log changes to it, and the UPDATE policy lets any admin, reviewer or leadership user change it on *any* request, including approved and rejected ones. The requester can set it on insert and change it while the request is `submitted`. This contradicts the F19.2 deliverable "trusted `created_at`" (spec §8) and lets closed-period Volume and Turnaround be rewritten. **Decision required.**
- **`TRUNCATE` is broader than reported.** `anon` and `authenticated` hold `TRUNCATE` (plus `TRIGGER`, `REFERENCES`, `MAINTAIN`) on `approval_stage_tracking`, `financial_requests`, `workflow_events`, `request_workflow_amendments` and `workflow_initialization_state`, granted directly by `postgres` through the schema's default privileges. RLS does not apply to `TRUNCATE`. No API path to it was found (PostgREST has no TRUNCATE; no invoker function runs dynamic SQL; no `pg_graphql`), so it is a defence-in-depth gap, not a demonstrated exposure. **Decision required.**
- **The event log is evidence, not proof.** Owners and reviewers can insert arbitrary `workflow_events` (any `event_type`, any `metadata`, including `"source": "db_trigger"`), and events written in one transaction share a timestamp, so order cannot be recovered. The current log shows no decision and no reopening.
- **RLS is consistent between requests, stages and events**, verified with claims-only identities: anon sees 0; the owner and the reviewer see 7/9/29; an unknown authenticated user sees 0. Coverage is thin: one requester, one reviewer, no admin or leadership user, and no second requester owning rows.
- **One correction to F19.5.2's observability notes:** `infinity`/`-infinity` cannot be stored in `financial_requests.created_at` through any trigger-firing write, because F4 casts `EXTRACT(... FROM created_at)` to `INT` and raises "cannot convert infinity to integer". Years above 9999 and BC dates *can* be stored and are rejected by the F18 parser, so `invalid_created_at` remains reachable. The F19.5.2 script was not modified.

## 2. Findings by investigation

### 2.1 Historical workflow integrity

**What the current schema enforces** (all validated, `convalidated = t`):

| Rule | Mechanism | Type |
| --- | --- | --- |
| Stage status in `active, completed, skipped, cancelled`; `completed_at` null exactly when active | CHECK constraints | constraint |
| `completed_at >= started_at` | CHECK | constraint |
| One active stage per request | unique partial index | constraint |
| Unique `(request_id, workflow_revision, stage_order)`; keys `NOT NULL INTEGER`; `stage_order >= 1` | UNIQUE, NOT NULL, CHECK | constraint |
| `queue_id` in the six-queue allowlist | CHECK via `f19_is_valid_queue_id` | constraint (function-based: rechecked only on write) |
| Stage keys, timestamps and queue immutable; closed stages immutable; no return to active | `f19_guard_stage_history` (BEFORE UPDATE only) | trigger |
| Decided statuses final (R1); API roles cannot change status, inserts must be `submitted` (R2); owner-only transitions (R3); a decision needs no active stage and a completed final stage of the current revision (R4) | `zz_f19_guard_request_status` | trigger |
| Amendment only for `submitted`/`under_review` | `f19_amend_request_workflow` | function |
| `authenticated` cannot write stages | `REVOKE INSERT, UPDATE, DELETE … FROM authenticated`; no INSERT/UPDATE/DELETE policy | grant + RLS |

**History before these rules.** Migrations show three earlier regimes:

1. **F16 (`20261113160000`)**: `GRANT SELECT, INSERT, UPDATE, DELETE` on stages to `authenticated`, with reviewer INSERT/UPDATE/DELETE policies. Reviewers could insert, edit or delete any stage row, including timestamps and queue.
2. **F19.2 integrity (`20261119030549`)** dropped those policies and revoked the grants. Its **preflight aborts** the migration if unknown queues, active stages on terminal requests, or multiple active stages exist. It does **not** repair data; the only data change is `workflow_revision = 1` for existing stages. So on any database where it applied, those three states were absent at that moment. It does **not** check terminal requests without stages, terminal requests whose final stage is not completed, edited timestamps, deleted stages, or decisions later reversed.
3. **Until the decision guard (`20261119072711`)**, admin and reviewer users could set `status` directly through the request UPDATE policy, and `f19_amend_request_workflow` accepted any status and reset it to `submitted`. A decision could therefore be reversed without trace in the stage table.

**Current data** (`out_data.txt` §1): 0 terminal requests with active stages; 1 request whose current revision has no stage (`a6ba0cb8`, workflow failed, no stages at all); `89ae7ad6` has a revision-2 stage but no revision-1 stage (initialization failed, then amended); 0 stage revisions above the request revision; 0 revision or stage-order gaps; amendment rows match revisions on all 7; 0 stages edited after closing; request `created_at` equals its `request_created` event time on all 7.

**Dating.** Row versions in `financial_requests`, `approval_stage_tracking` and `workflow_events` have xmin 1238–1249; F19.2 integrity objects 1237; the status-guard trigger 1277. All current rows were written in the pre-guard window, and none was changed afterwards. (xmin dating is reliable here because nothing has been frozen or wrapped; it is evidence about this database only.)

### 2.2 `created_at` integrity

- Column: `timestamptz NOT NULL DEFAULT now()`.
- F4 (`f4_enforce_request_metadata`, BEFORE INSERT OR UPDATE) sets it only `IF TG_OP = 'INSERT' AND NEW.created_at IS NULL`; a supplied value is kept. It derives fiscal fields with `EXTRACT(...)::INT`, which **raises for `±infinity`** and so blocks infinite values on insert and update.
- `f19_guard_request_workflow_fields` protects amount, funding, grant, PI, program and routing after initialization, **not `created_at`**. No other trigger references it on UPDATE.
- F5 tracked fields (`f5_tracked_fields`) do **not** include `created_at`: changes are not logged.
- Grants: `anon`, `authenticated` and `service_role` all have column INSERT and UPDATE on `created_at`.
- Policies:
  - INSERT `WITH CHECK (auth.uid() = user_id)`: the owner may supply any `created_at`; R2 only forces `status = submitted`.
  - UPDATE `USING/WITH CHECK ((auth.uid() = user_id AND status = 'submitted') OR f16_is_admin_or_reviewer())`: the owner may change it while `submitted`; **admin, reviewer and leadership may change it on any request in any status**. R1 freezes only `status`.

Database-valid versus F19-valid (`out_created_at.txt`, `parser/result.txt`):

| Value (as PostgREST JSON) | Storable in `financial_requests.created_at`? | F18 `toValidInstant` |
| --- | --- | --- |
| `"infinity"`, `"-infinity"` | No: F4 raises on insert and update | invalid |
| `"10000-01-01T00:00:00+00:00"` … `"294276-…"` | Yes | invalid (5–6 digit year) |
| `"4713-01-01T00:00:00+00:00 BC"` | Yes | invalid (`BC` suffix) |
| `"0001-01-01T00:00:00+00:00"` … `"9999-12-31T23:59:59.999999+00:00"` | Yes | valid; sub-millisecond digits truncated |

For stage timestamps no trigger computes from them, so `±infinity` is storable by a privileged writer (service_role or the owner role) and passes every CHECK.

### 2.3 `TRUNCATE` privilege

- ACL entries (`aclexplode(relacl)`): `anon` and `authenticated` are granted `TRUNCATE` **directly**, grantor `postgres`; **not** through `PUBLIC` (no PUBLIC entry exists) and **not** through membership (both are NOLOGIN; `authenticator` is a member with `inherit = false`, using `SET ROLE`).
- Source: `pg_default_acl` for schema `public` grants `DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` to `anon`, `authenticated` and `service_role` on tables created by `postgres` or `supabase_admin`. These are Supabase's standard default privileges, not a local artifact, so any database built from these migrations carries them. F19.2 revoked only `INSERT, UPDATE, DELETE` and only from `authenticated`.
- Effective privileges (`has_table_privilege`):
  - `anon`: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES on all three F19 tables.
  - `authenticated`: SELECT, TRUNCATE, TRIGGER, REFERENCES on stages; everything on requests and events.
- RLS: policies filter rows for SELECT, INSERT, UPDATE and DELETE. **TRUNCATE is not row-level and is never checked against RLS**, and it does not fire row-level DELETE triggers. A role holding TRUNCATE on every referencing table can also `TRUNCATE financial_requests CASCADE`.
- Reachability: PostgREST exposes no TRUNCATE; no `pg_graphql`; no public function executable by `authenticated` contains dynamic `EXECUTE`; API roles lack `CREATE` on `public`. It is reachable only with SQL-level access as `authenticator`/`anon`/`authenticated` (leaked DB credentials, a future invoker function with dynamic SQL, or direct pooler access). `MAINTAIN` (PG17) similarly allows `LOCK TABLE`/`VACUUM` and `TRIGGER` allows attaching existing trigger functions, on the same path.

### 2.4 Workflow event history

- Writers:
  - INSERT policies: owners for their own requests with `actor_user_id = auth.uid()`, and admin/reviewer/leadership for any request. Neither restricts `event_type`, `message`, `metadata` or `created_at`.
  - No UPDATE or DELETE policy exists, so RLS blocks those for API roles despite the table grants.
  - No trigger on `workflow_events`.
  - `service_role` (BYPASSRLS), the owner, and any TRUNCATE holder can remove events.
  - `ON DELETE CASCADE` removes events with their request.
- Immutability: rows are immutable to API roles under RLS, but not to privileged roles, and not under TRUNCATE.
- Sufficiency:
  - A trigger-made `status_changed` event (F5, `source = db_trigger`) is written for every status UPDATE that fires triggers, so a reopening through UPDATE would normally leave a trace.
  - But an identical-looking event can be forged by the same users, deletion leaves no trace, and events from one transaction share `created_at`. For `1474ce19`, `31f19c6a` and `51372359`, both `status_changed` events have identical timestamps, so "latest event" is ambiguous; that is why one consistency check returned 1.
  - Decision events (`approval_approved`, `approval_rejected`, written by `f16_record_approval_decision`) are likewise insertable by reviewers.
- Current data: 29 events. No decision events, no `status_changed` into or out of a terminal status; every `status_changed` is `submitted` ↔ `under_review`. This is **evidence** that no decision was reversed in this database. It is **not proof**: nothing prevents deletion by privileged roles or truncation, and forged events would look the same.

### 2.5 RLS and ownership scope

- Requests: SELECT `auth.uid() = user_id OR f16_is_admin_or_reviewer()` (admin, reviewer, leadership).
- Stages: SELECT `f16_can_view_approval_stage(request_id)`, a SECURITY DEFINER function that applies the same owner-or-role rule to the parent request. Ownership propagates from request to stage.
- Events: SELECT `EXISTS (request visible as owner) OR f16_is_admin_or_reviewer()`. Consistent with the above.
- `anon`: no policies at all, so it sees nothing despite holding table grants.

Observed with claims-only identities (no identity created; `SET LOCAL ROLE` inside a rolled-back read-only transaction):

| Identity | Requests | Stages | Events | Role function |
| --- | --- | --- | --- | --- |
| `anon` | 0 | 0 | 0 | n/a |
| Owner `aaaaaaaa` (no role) | 7 | 9 | 29 | false |
| Reviewer `bbbbbbbb` (owns nothing) | 7 | 9 | 29 | true |
| Unknown authenticated `cccccccc` (claims only) | 0 | 0 | 0 | false |

Coverage: 2 auth users, 1 request owner, 1 reviewer role. The owner and the reviewer see the same rows, so "requester sees only own" is shown only negatively (the unknown user sees nothing). Needed for real coverage, in a disposable database: a second requester owning rows, to check each sees only their own requests, stages and events; an admin and a leadership user; a reviewer who also owns requests; a stage whose request is owned by another requester; and requester read attempts on another user's stages by ID.

## 3. State classification

| State | Impossible (validated constraint) | Prevented for new writes (trigger, API role or function) | Historically possible on databases built from these migrations | Observed now |
| --- | --- | --- | --- | --- |
| Terminal request with active stage | No | R4 blocks deciding with an active stage. A privileged stage insert is still possible. | Yes before F19.2 (direct status update), but F19.2 preflight aborts if any exist | No (0) |
| Multiple active stages per request | Yes (unique index) | n/a | Before F19.2; preflight aborts | No |
| Unknown queue | Yes, for rows written under the CHECK | n/a | Before F19.2; preflight aborts | No |
| Tie or null key at highest `(revision, order)` | Yes | n/a | No (columns and UNIQUE predate data via F19.2) | No |
| Completed stage without `completed_at`, or reversed timestamps | Yes | n/a | Before F19.2, but now validated | No |
| Stage `±infinity` or out-of-range timestamps | No | No trigger; only privileged writers | Yes (F16 reviewer writes) | No |
| Request `created_at` `±infinity` | No constraint, but F4 raises on insert/update | Yes, while F4 is enabled | Only if F4 was disabled or bypassed | No |
| Request `created_at` year > 9999 or BC | No | No: owner on insert or while submitted; admin, reviewer and leadership at any time | Yes | No |
| `created_at` changed after the decision | No | No | Yes | Not detectable: no audit, current values all equal their creation events |
| Decided request reopened or reversed | No | R1 plus amendment eligibility | Yes before `20261119072711` | No evidence (no terminal events); not provable |
| Decided request with non-completed final stage | No | R4 | Yes before the guard | No terminal requests |
| Terminal request with no stages | No | R4 requires a completed final stage | Yes (pre-F16 data, failed workflows, direct updates) | No terminal requests |
| Latest revision with no stage | No | Initialization and amendment functions create stages | Yes | Yes: 1 (`a6ba0cb8`, failed workflow, pending) |
| Earlier revision with no stage | No | n/a | Yes | Yes: 1 (`89ae7ad6`, revision 1) |
| Stage rows edited or deleted after creation | No | Stage guard (UPDATE) and revoked grants; DELETE by privileged roles | Yes under F16 reviewer policies | Edited after close: 0. Deletions undetectable. |
| Forged or conflicting events | No | No: owner and reviewer INSERT policies accept any content | Yes | No conflicting terminal events; 1 ambiguous order (same timestamp) |
| Event log truncated or deleted | No | RLS blocks DELETE for API roles; TRUNCATE not blocked | Yes | Undetectable |

## 4. Security findings

| ID | Finding | Severity | Confidence | Evidence |
| --- | --- | --- | --- | --- |
| S1 | `created_at` can be supplied on insert and changed later: by the owner while `submitted`, and by admin, reviewer and leadership on any request, including decided ones. Unlogged. Rewrites closed-period Volume and Turnaround and can create `decision_before_creation` or `invalid_created_at`. Contradicts the F19.2 "trusted `created_at`" deliverable. | **Medium** (integrity; requires an authenticated or privileged user) | High (grants, policies and trigger code); not exercised by a write | column privileges, policies, F4/F5/F19 trigger bodies |
| S2 | `TRUNCATE`, `TRIGGER`, `MAINTAIN` and `REFERENCES` granted directly to `anon` and `authenticated` on all F19 tables, including `financial_requests` (CASCADE) and `workflow_events`. RLS cannot stop TRUNCATE. No API path found. | **Low** (defence in depth); High if SQL-level access as an API role is ever possible | High on the privilege; medium on "no reachable path" | `aclexplode`, `pg_default_acl`, `has_table_privilege`, function scan |
| S3 | `anon` keeps INSERT, UPDATE and DELETE grants on stages, amendments and initialization state (F19.2 revoked only from `authenticated`). Blocked today only by the absence of `anon` policies. | Low | High | ACL entries, policy list |
| S4 | `f19_guard_request_workflow_fields` trusts the custom settings `app.f19_trusted_workflow_write` and `app.f19_allow_amendment_write`, which any role can set. The decision-guard migration itself states such settings are untrusted. Not reachable through PostgREST (clients cannot run `SET`). | Low | Medium | function body |
| S5 | Event log is forgeable by owners and reviewers, removable by privileged roles or TRUNCATE, and unordered within a transaction. Cannot serve as proof of workflow history. | Informational | High | policies, event data |

## 5. Limitations and recommended follow-up

Limitations:

- No write path was exercised. S1 to S4 are derived from catalog definitions and code, not demonstrated.
- The current data is 7 fixture requests from one pre-guard window: there are no decided requests and no real history to classify.
- Absence of anomalies does not show historical validity. Deleted stages, deleted or truncated events, and changed `created_at` values leave no trace in this schema.
- xmin dating applies only to this database.
- The privilege model of hosted Supabase was not inspected. The conclusion that these default privileges are standard rests on the local `pg_default_acl` and Supabase's known defaults.

Follow-up verification (synthetic scenarios belong in a disposable database, not here):

1. **S1 decision:** whether `created_at` should become immutable (trigger forcing `now()` on insert and rejecting changes) and whether F5 should log it. Then test owner, reviewer and admin attempts in a disposable database.
2. **S2/S3 decision:** whether to `REVOKE TRUNCATE, TRIGGER, MAINTAIN, REFERENCES` (and the unused `anon` write grants) on F19 tables, and whether to alter the default privileges for future tables.
3. Disposable-database scenarios: owner backdating; reviewer editing `created_at` on a decided request; year-10000 and BC values flowing to `invalid_created_at`; forged `status_changed` events; truncation as an API role; the second-requester, admin and leadership RLS matrix from §2.5.
4. Record F19.5.4's correction of the F19.5.2 `invalid_created_at` observability note (`infinity` is blocked by F4; out-of-range years are not) when the F19.5 documentation is written.

## 6. No modification

- Database: before and after all investigation queries, total `n_tup_ins + n_tup_upd + n_tup_del` across user tables stayed at 1794 and the WAL position at `0/22F4358` (see the final check in the session). Every session ran with `default_transaction_read_only = on`; RLS checks used `SET LOCAL ROLE` and `set_config(..., true)` inside rolled-back transactions; no identity was created.
- Repository: no tracked or untracked file was created, changed or removed; all scripts and output are in this scratchpad folder.
