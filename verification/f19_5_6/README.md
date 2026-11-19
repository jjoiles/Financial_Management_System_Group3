# F19.5.6 – Final Efficiency Metrics Verification Report

**Feature:** F19 Efficiency & Process Analytics
**Branch:** `feature/f19-efficiency-analytics` (HEAD `7a8a170`, unchanged by F19.5)
**Catalog version verified:** `2026-11-19.2`
**Report date:** 2026-11-19

## 1. Summary

The eight F19 efficiency metrics were verified at the calculation layer in five checkpoints:

1. An audit of the existing local database.
2. Independent read-only SQL over its records.
3. A comparison of the public TypeScript entry point against that SQL.
4. Security hardening, tested in disposable databases.
5. Synthetic scenarios that exercise every metric with non-empty values and edge cases.

| Measure                                                        | Result                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Metric discrepancies found (spec vs catalog vs implementation) | **0**                                                                |
| F19.5.2 SQL vs F19.5.1 audit                                   | 78 / 78 rows agree                                                   |
| F19.5.3 TypeScript vs SQL (existing data)                      | 182 comparisons, 0 mismatches, in each of 4 runs                     |
| F19.5.5 synthetic leaf comparisons                             | 14,009, 0 mismatches, in each of 2 database-mode runs                |
| Security hardening regression (disposable database)            | F19.5.4.1: 8/8 sections; F19.5.4.2: 5/5 sections; F19.2 scripts: 3/3 |

**Not claimed.**

- **No end-to-end verification of PostgREST, Auth or the network loader** (`loadEfficiencyDataset`). Every load used the real F19.3 reader (`readAllPages`) and integrity check (`checkDatasetIntegrity`), fed by controlled fetchers or by read-only database JSON exports.
- **The two new migrations are not applied to the existing local database.** They were tested only in disposable databases.

## 2. Overall results

Status key: **Passed** – verified with no open issue in scope. **Passed with limitations** – verified, with limits stated. **Not tested** – outside what was exercised. **Deferred** – known, intentionally left for later work.

| Checkpoint | Purpose                                                 | Verification method                                                                                               | Result                                         | Evidence                                                                                             | Remaining limitations                                                                                        |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| F19.5.1    | Audit the existing local database and plan verification | Read-only catalog and data queries against the local stack                                                        | **Passed with limitations**                    | Session record only (no artifact; see §4.1)                                                          | 7 fixture requests: no decided requests, no completed stages; several codes structurally impossible          |
| F19.5.2    | Independent SQL expectations from existing records      | `verification/f19_5_2_metric_verification.sql` (read-only transaction, rollback)                                  | **Passed** (78/78)                             | `verification/f19_5_2_metric_verification.sql`                                                       | Five of eight metrics only reach empty or no-data on this data; two observability notes are now stale (§4.2) |
| F19.5.3    | Public TypeScript vs SQL on real exported rows          | Read-only RLS-scoped JSON export → real `readAllPages` / `checkDatasetIntegrity` → `calculateEfficiencyMetrics`   | **Passed with limitations** (182/182 × 4 runs) | Session scratchpad only (§7)                                                                         | Calculation layer only; same empty-data limits as F19.5.2                                                    |
| F19.5.4    | Historical workflow and security audit                  | Read-only inspection of grants, policies, triggers, xmin dating and events                                        | **Passed** (audit complete); findings S1–S5    | `evidence/F19_5_4_historical_workflow_and_security_audit.md`                                         | History cannot be authenticated retroactively                                                                |
| F19.5.4.1  | S1 `created_at` immutability; S2/S3 privileges          | New migration; disposable-database regression and static tests                                                    | **Passed** (disposable only)                   | `verification/f19_5_4_1_*`, `src/lib/workflow/security-hardening-migration.test.ts`                  | Not applied to the local database; history unverifiable                                                      |
| F19.5.4.2  | Event provenance; default DELETE; catalog update        | New migration; disposable-database regression; static and catalog tests                                           | **Passed** (disposable only)                   | `verification/f19_5_4_2_event_provenance.sql`, `src/lib/workflow/event-provenance-migration.test.ts` | Not applied locally; pre-migration events unverifiable; `service_role` keeps UPDATE/DELETE on events         |
| F19.5.5    | Synthetic scenarios: non-empty values and edge cases    | Hand calculations + independent SQL (database-backed scenarios) vs public entry point; determinism; mutation test | **Passed with limitations** (14,009 / 0)       | `verification/f19_5_5/`, `evidence/F19_5_5_database_mode_report.md`                                  | 19 TypeScript-only scenarios have no SQL cross-check; gaps in §5                                             |
| —          | PostgREST / Auth / network loader                       | —                                                                                                                 | **Not tested**                                 | —                                                                                                    | No PostgREST service in the local stack                                                                      |
| —          | Requester-scoped RLS on synthetic data                  | —                                                                                                                 | **Not tested**                                 | —                                                                                                    | Reviewer view only                                                                                           |
| S4         | `app.f19_*` session-setting trust                       | —                                                                                                                 | **Deferred**                                   | `docs/F19_Security_Hardening.md` §7                                                                  | Needs its own design review                                                                                  |

## 3. Checkpoint detail

### 3.1 F19.5.1 – Existing database audit

- **Stack:** a local Supabase database container only (no PostgREST or Auth service), PostgreSQL 17.11. 13 migrations are recorded, latest `20261119072711_f19_2_decision_status_guard`.
- **Population:** 7 requests (1 `submitted`, 6 `under_review`), 9 stages (6 `active`, 3 `cancelled`) and 29 workflow events. There are no approved, rejected or completed requests and no completed stages.
  - Every request belongs to one fixture user and was committed by `verification/f19_2_regression.sql`, which has no cleanup.
  - One pending request has no stages. Three requests have two workflow revisions. All rows were written within about 40 ms.
- **Constraints:** all stage CHECK and UNIQUE constraints and the single-active-stage index are validated. That makes `unrecognized_stage_status`, `stage_missing_completed_at`, `duplicate_active_stages`, `unknown_queue` and the tie / invalid-key forms of `terminal_stage_invalid` impossible in stored rows.
- **Findings carried forward:**
  - `created_at` was client-writable (resolved by F19.5.4.1).
  - `anon` and `authenticated` held `TRUNCATE` (resolved by F19.5.4.1).
- **Two assumptions later corrected:**
  - F19.5.2: `completed_status` is reachable through a table-owner insert, because status guard R2 binds only API roles.
  - F19.5.2: `invalid_stage_timestamps` is possible, because `±infinity` and five-digit years pass the stage CHECKs.

### 3.2 F19.5.2 – Independent SQL verification

- **Script:** `verification/f19_5_2_metric_verification.sql`.
  - It forces `default_transaction_read_only = on`, runs in one REPEATABLE READ READ ONLY transaction, and rolls back.
  - It uses no F19.4 code and no F19 database helper; queue IDs are the literal `QUEUES` keys.
  - Each population is classified by one ordered `CASE` expression over the whole dataset, and the period filter is applied afterwards. Instants are compared as `floor(epoch × 1000)` milliseconds to match JavaScript.
- **Results** (November 2026, UTC):

  | Metric                                 | Result                                                                            |
  | -------------------------------------- | --------------------------------------------------------------------------------- |
  | Request Volume                         | 7                                                                                 |
  | Active Queue Workload                  | `department_budget` 5, `dean_office` 1, other queues 0; `pending_without_stage` 1 |
  | Stage Processing Time (avg / median)   | no-data (`in_progress_stage` 6, `skipped_or_cancelled_stage` 3)                   |
  | Request Turnaround Time (avg / median) | no-data (empty population)                                                        |
  | Approval Rate                          | no-data (A = R = 0)                                                               |
  | Queue Throughput                       | 0 everywhere (`skipped_or_cancelled_stage` 3)                                     |

- **Agreement with the F19.5.1 audit:** 78 / 78 rows.
- **Validation:** the script's statement reproduced the spec §5 and §5.8 worked examples when the tables were replaced with inline `VALUES` fixtures (session scratchpad).

### 3.3 F19.5.3 – TypeScript versus the existing database

- **Export:** a read-only JSON export, run as the authenticated reviewer (RLS applies), of exactly the loader columns: 7 requests, 9 stages, 19 instants. Postgres `to_json` timestamps keep their offsets; psql display text was not used.
- **Load:** the export passed through the real `readAllPages` (at page sizes 500 and 2) and `checkDatasetIntegrity`. The harness supplied only the read windows and `userId` / `attempts`. All eight metrics were then calculated by `calculateEfficiencyMetrics`.
- **Comparison:** 182 comparisons per run, 0 mismatches, including:
  - every exclusion code and its catalog order;
  - flags, queue groups and `pending_without_stage`;
  - status, metric ID, catalog version, period echo and workload snapshot.
- **Timestamps:**
  - `toValidInstant` on the exported strings equals the SQL millisecond value for all 19 instants, from both a UTC and a `-05:00` export.
  - Sub-millisecond digits are truncated identically on both sides.
- **Reproducibility:** 4 runs (TZ = UTC twice, America/Los_Angeles, Asia/Kolkata) gave identical results.
- **Negative control:** tampered expectations failed on exactly the 3 tampered fields.

### 3.4 F19.5.4, F19.5.4.1 and F19.5.4.2 – Security hardening

The F19.5.4 audit (`evidence/F19_5_4_historical_workflow_and_security_audit.md`) found five issues:

- **S1:** `created_at` was writable by clients and changeable after a decision.
- **S2:** `anon` and `authenticated` held TRUNCATE, TRIGGER, REFERENCES and MAINTAIN, which RLS cannot govern.
- **S3:** `anon` kept unused write grants.
- **S4:** the workflow-field guard trusts `app.f19_*` session settings.
- **S5:** workflow events could be forged.

**F19.5.4.1** (`20261119120100_f19_5_4_1_security_hardening.sql`):

- **`created_at` assigned on insert.** `f19_assign_request_created_at` runs first, so F4's derived metadata uses the database value.
- **`created_at` immutable after insert.** `zz_f19_guard_request_created_at` runs after every trigger that modifies the row; there is no session-setting bypass.
- **TRUNCATE, TRIGGER, REFERENCES and MAINTAIN revoked** from `anon` and `authenticated` on the five F19 tables; `anon` loses direct writes too.
- **`authenticated` keeps only writes that have a policy and an app path:** INSERT/UPDATE on requests, INSERT on events.
- **Default privileges corrected** for role `postgres` in schema `public` only.

**F19.5.4.2** (`20261119130000_f19_5_4_2_event_provenance.sql`):

- **Provenance guard.** `f19_guard_workflow_event_provenance` trusts only table-owner context; every database event writer is a SECURITY DEFINER function owned by `postgres`.
- **Client inserts are restricted:**
  - the 12 database-generated event types and any non-`client` source are rejected;
  - the actor comes from `auth.uid()`, the time from `now()`, and `source: "client"` is stamped.
- **Default DELETE removed** from `authenticated` for future tables.
- **Catalog `2026-11-19.2`:** `created_at_client_writable` is replaced by `created_at_unverified_before_hardening` (not resolvable).

**Disposable-database results** (`verification/f19_5_4_1_disposable_db.sh`):

- **F19.5.4.1 regression:** 8/8 sections pass. That covers 21 insert attempts and 35 role-by-status update attempts, all rejected.
- **F19.5.4.2 regression:** 5/5 sections pass, with 77 impersonation attempts rejected. All 12 database event types are still written unchanged by their own paths.
- **Existing F19.2 scripts on the hardened schema:** status guard, regression and concurrency all pass.
- **History unchanged by the migrations:** request and event snapshots are identical before and after.
- **Negative controls:** both regressions fail without their migration.

### 3.5 F19.5.5 – Synthetic scenario verification

`verification/f19_5_5/` holds 22 scenarios:

- **Database-backed (3):** the spec §5 example, the §5.8 amended request, and a mixed set of storable edge cases.
- **TypeScript-only (9):** unknown queues; §5.2 duplicate active stages; multi-queue workload; decisive-stage ties and invalid keys; timestamp validity, offsets and boundaries; turnaround offsets; prototypes; an empty dataset; an all-excluded dataset.
- **Load-gating (10):** failed, incomplete, field-missing, not-loaded, both-failed and cancelled reads.

**Expected values.** Hand calculations cover every scenario. The unmodified F19.5.2 SQL also covers the three database-backed scenarios. Those are seeded into a disposable database built from all 15 migrations, with triggers bypassed for the seeding transaction only, and exported in an `America/New_York` session. Hand, SQL and TypeScript therefore agree three ways for those scenarios.

| Source                                                                    | Runs   | Leaf comparisons | Mismatches |
| ------------------------------------------------------------------------- | ------ | ---------------- | ---------- |
| TypeScript vs hand                                                        | 31     | 3,677            | 0          |
| Determinism (page sizes 1/2/7/500, reversed and rotated order)            | 12     | 7,680            | 0          |
| Property checks (queue total vs distinct requests; decisions vs requests) | 2      | 4                | 0          |
| Database export preserved every fixture value                             | 3      | 218              | 0          |
| SQL vs hand                                                               | 9      | 1,026            | 0          |
| TypeScript (database rows) vs hand                                        | 9      | 1,404            | 0          |
| **Total**                                                                 | **66** | **14,009**       | **0**      |

- **Reproducibility:** two complete database-mode runs from fresh containers produced identical results (13,949 leaves, excluding wall-clock read windows).
- **Mutation test:** a copy with five expectations deliberately wrong failed on exactly the 11 runs that use them.
- **Observations, not discrepancies:**
  - The §5.7 `request_field_missing` bullet is not exhaustive: workload and stage time are blocked too, per the catalog.
  - Microsecond-reversed instants within one millisecond count as 0 h.
  - When both reads fail, only the first failure is classified.

## 4. Security and migration status

| Migration                                         | Content                          | Tested                                                            | Applied to the existing local database |
| ------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `20261119120100_f19_5_4_1_security_hardening.sql` | S1, S2, S3                       | Disposable databases only (F19.5.4.1, F19.5.4.2 and F19.5.5 runs) | **No**                                 |
| `20261119130000_f19_5_4_2_event_provenance.sql`   | Event provenance, default DELETE | Disposable databases only (F19.5.4.2 and F19.5.5 runs)            | **No**                                 |

**New writes vs history.**

- **Verified for new writes (disposable databases):**
  - `created_at` is database-assigned and immutable for every role and status.
  - Clients cannot write a database-generated event type or source, nor attribute an event to another user.
  - The revoked privileges are refused.
- **Not verifiable retroactively:**
  - Requests stored before the hardening migration keep their original `created_at`, which may have been client-supplied or changed without a log entry. The catalog now records this as `created_at_unverified_before_hardening`.
  - Events stored before the provenance migration cannot be shown to be database-generated; a forged historical event looks identical to a real one.
  - Deleted stages and truncated or deleted events leave no trace.
  - In the local database, every current row was written after F19.2 and before the status guard (transaction-ID dating). There is no evidence of a reversed decision, but that is not proof.

**Outstanding security concerns.**

- **S4 (deferred):** `f19_guard_request_workflow_fields` trusts the client-settable `app.f19_trusted_workflow_write` / `app.f19_allow_amendment_write` settings. There is no known PostgREST path; replacing the mechanism needs a separate design review (`docs/F19_Security_Hardening.md` §7).
- **`service_role`** keeps UPDATE and DELETE on `workflow_events` (bypasses RLS by design).
- **`supabase_admin`** default privileges in `public` are unchanged (out of scope).
- **Client events** remain client-authored content, marked `source: "client"`. `f19_complete_workflow_initialization` stores caller-supplied message and metadata fields, but always overwrites `source`.

## 5. Known issues and limitations

These are verification or environment limits. None is a metric-calculation failure.

| Item                                                                                                           | Status                           | Detail                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/sla-dashboard.test.ts` fails to load                                                                  | Pre-existing, untouched          | Imports `./sla-dashboard`, which does not exist. Not part of F19.                                                                                                                                                                              |
| 14 TypeScript errors                                                                                           | Pre-existing, untouched          | All in `src/lib/sla-dashboard.test.ts` (`npx tsc --noEmit`).                                                                                                                                                                                   |
| PostgREST / Auth / network loader                                                                              | Not tested                       | No PostgREST service in the local stack; `loadEfficiencyDataset` and its retry policy are covered only by unit tests (`efficiency-data-loader.test.ts`).                                                                                       |
| Requester-specific RLS on synthetic data                                                                       | Not tested                       | Exports used the reviewer's view. F19.5.4 checked RLS scope on existing data with claims-only identities (anon 0; owner and reviewer 7/9/29; unknown user 0), but coverage is thin: one requester, one reviewer.                               |
| SQL cross-check of the 19 TypeScript-only scenarios                                                            | Not performed                    | The database cannot store those inputs; they rely on hand calculation.                                                                                                                                                                         |
| Fiscal and academic periods                                                                                    | Not tested                       | Calendar months and Eastern custom ranges only.                                                                                                                                                                                                |
| Prototype ownership scoping                                                                                    | Not testable at this layer       | The caller must scope prototypes to the signed-in owner (AGENTS.md).                                                                                                                                                                           |
| Large-volume performance                                                                                       | Not tested                       | —                                                                                                                                                                                                                                              |
| Load-integrity reasons `count_unavailable`, `max_pages_exceeded`, `page_overflow`, out-of-order / invalid keys | Covered by F19.3 unit tests only | Not in the F19.5.5 scenarios.                                                                                                                                                                                                                  |
| Historical workflow and event provenance                                                                       | Not resolvable                   | See §4.                                                                                                                                                                                                                                        |
| Stale annotations in `verification/f19_5_2_metric_verification.sql`                                            | Documented, not changed          | Its observability notes still say `created_at` is client-writable and that `infinity` is accepted. F19.5.4 showed F4 rejects `±infinity`, and F19.5.4.1 makes `created_at` database-assigned once applied. The script's values are unaffected. |

## 6. Evidence and reproduction

### 6.1 Repository artifacts

| Path                                                                                                           | Checkpoint                                                                  |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `verification/f19_5_2_metric_verification.sql`                                                                 | F19.5.2                                                                     |
| `supabase/migrations/20261119120100_f19_5_4_1_security_hardening.sql`                                          | F19.5.4.1                                                                   |
| `supabase/migrations/20261119130000_f19_5_4_2_event_provenance.sql`                                            | F19.5.4.2                                                                   |
| `verification/f19_5_4_1_disposable_db.sh`                                                                      | F19.5.4.1 / F19.5.4.2 runner                                                |
| `verification/f19_5_4_1_security_hardening.sql`                                                                | F19.5.4.1 regression                                                        |
| `verification/f19_5_4_2_event_provenance.sql`                                                                  | F19.5.4.2 regression                                                        |
| `src/lib/workflow/security-hardening-migration.test.ts`, `src/lib/workflow/event-provenance-migration.test.ts` | Static migration tests                                                      |
| `src/lib/efficiency-metrics.ts`, `src/lib/efficiency-metrics.test.ts`                                          | Catalog `2026-11-19.2` and its tests                                        |
| `docs/F19_Security_Hardening.md`; `docs/F19_Efficiency_Metrics.md` §8.4 and §9                                 | Design, privilege matrix, S4                                                |
| `verification/f19_5_5/` (README, fixtures, scenarios, harness, tests, `db/`)                                   | F19.5.5                                                                     |
| `verification/f19_5_6/evidence/F19_5_4_historical_workflow_and_security_audit.md`                              | F19.5.4 audit (verbatim copy of the scratchpad report)                      |
| `verification/f19_5_6/evidence/F19_5_5_database_mode_report.md`                                                | F19.5.5 comparison report from the second database-mode run (verbatim copy) |

### 6.2 Evidence kept outside the repository

- **F19.5.1:** the audit has no written artifact. Its findings are summarised in §3.1, and its claims were re-checked by F19.5.2.
- **F19.5.3:** the harness and its exports (including database rows, deliberately kept out of the repository) were in the session scratchpad and are not reproducible from the repository alone. The F19.5.5 harness reuses the same approach.
- **Raw query outputs:** the F19.5.4 query outputs and the F19.5.5 run directories are also in the session scratchpad.

### 6.3 Reproduction commands

```sh
# F19 unit, static-migration and synthetic (TypeScript-mode) suites
npx vitest run src/lib/efficiency-*.test.ts src/lib/workflow/decision-status-guard-migration.test.ts \
  src/lib/workflow/security-hardening-migration.test.ts src/lib/workflow/event-provenance-migration.test.ts \
  verification/f19_5_5

# Full suite and type check
npx vitest run
npx tsc --noEmit

# F19.5.2 independent SQL (read-only) against the local stack
docker exec -i <local-db-container> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
  < verification/f19_5_2_metric_verification.sql

# F19.5.4.1 / F19.5.4.2 and F19.5.5 database mode: disposable containers only
IMAGE="$(docker inspect <local-db-container> --format '{{.Image}}')"
bash verification/f19_5_4_1_disposable_db.sh "$IMAGE"
bash verification/f19_5_5/db/run.sh "$IMAGE" <output-dir>
```

### 6.4 Run log at report time (2026-11-19, 11:13 UTC)

- **Run for this report:**
  - The F19 suites above: 16 files pass, 652 tests pass, 12 skipped (database mode).
  - `npx vitest run`: 1268 tests pass and 12 are skipped; one file (`sla-dashboard.test.ts`) fails to load.
  - `npx tsc --noEmit`: 14 errors, all in `sla-dashboard.test.ts`.
- **Most recent earlier runs, not repeated for this report:**
  - F19.5.4.1/F19.5.4.2 disposable runner: last run during F19.5.4.2, all checks passed.
  - F19.5.5 database mode: two runs during F19.5.5, both passed with identical results.

## 7. Final repository and database state

**Repository** (inspected at report time):

- **Staged:** nothing (`git diff --cached` is empty).
- **Committed:** nothing during F19.5. HEAD is `7a8a170`, the same as before F19.5.1.
- **Pushed:** nothing. No remote-tracking branch contains HEAD, according to local refs (no fetch). The branch tracks `origin/main` and is 8 commits ahead; those 8 commits predate F19.5.
- **Preserved files:** `src/lib/sla-dashboard.test.ts` (14,783 bytes, last modified 2026-11-18T23:12) and `verification/debug_claim.sql` (1 byte, last modified 2026-11-18T23:10) are unchanged. Both modification times predate F19.5.

`git status --short`, before this report's own files were added (`verification/f19_5_6/` is the only change since):

```
 M docs/F11_Verification_Report.md
 M docs/F19_Efficiency_Metrics.md
 M src/lib/efficiency-metrics.test.ts
 M src/lib/efficiency-metrics.ts
 M verification/f11-notifications.sql
?? docs/F19_Security_Hardening.md
?? src/lib/efficiency-active-queue-workload.test.ts
?? src/lib/efficiency-active-queue-workload.ts
?? src/lib/efficiency-analytics.test.ts
?? src/lib/efficiency-analytics.ts
?? src/lib/efficiency-calculation.ts
?? src/lib/efficiency-classification.ts
?? src/lib/efficiency-decision-metrics.test.ts
?? src/lib/efficiency-decision-metrics.ts
?? src/lib/efficiency-population-classification.test.ts
?? src/lib/efficiency-population.test.ts
?? src/lib/efficiency-population.ts
?? src/lib/efficiency-queue-throughput.test.ts
?? src/lib/efficiency-queue-throughput.ts
?? src/lib/efficiency-request-volume.test.ts
?? src/lib/efficiency-request-volume.ts
?? src/lib/efficiency-stage-processing-time.test.ts
?? src/lib/efficiency-stage-processing-time.ts
?? src/lib/efficiency-stats.test.ts
?? src/lib/efficiency-stats.ts
?? src/lib/sla-dashboard.test.ts
?? src/lib/workflow/decision-status-guard-migration.test.ts
?? src/lib/workflow/event-provenance-migration.test.ts
?? src/lib/workflow/security-hardening-migration.test.ts
?? supabase/migrations/20261119072711_f19_2_decision_status_guard.sql
?? supabase/migrations/20261119120000_f19_5_4_1_security_hardening.sql
?? supabase/migrations/20261119130000_f19_5_4_2_event_provenance.sql
?? verification/debug_claim.sql
?? verification/f19_2_status_guard.sql
?? verification/f19_2_status_guard_concurrency.sh
?? verification/f19_5_2_metric_verification.sql
?? verification/f19_5_4_1_disposable_db.sh
?? verification/f19_5_4_1_security_hardening.sql
?? verification/f19_5_4_2_event_provenance.sql
?? verification/f19_5_5/
```

**Existing local database** (read-only session at report time):

| Item                                             | Value                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Latest applied migration                         | `20261119072711` (13 recorded)                                      |
| Requests / stages / workflow events              | 7 / 9 / 29                                                          |
| F19.5.4 hardening triggers present               | 0 (the new migrations are not applied)                              |
| User-table insert + update + delete counter      | 1794 (unchanged since first measured in F19.5.2)                    |
| Request and stage rows                           | Identical, field by field, to the F19.5.3 export taken at 10:04 UTC |
| Privileges, default privileges, request triggers | Identical to the baseline captured before F19.5.4.1                 |

**Not modified by F19.5.2 through F19.5.5.** Every local-database session was forced read-only (`default_transaction_read_only = on`), and all writes and migrations ran in disposable containers, none of which remain.

**One unexplained but benign change.** The WAL position moved from `0/22F4358` to `0/22F8120` during F19.5.4.1, including a timed checkpoint. Read-only queries were measured to generate no WAL. The cluster's own background workers (`pg_cron`, `pg_net`, autovacuum) were active in other databases at the time. The records could not be decoded without installing an extension, but every data, schema and privilege check shows no change.

## 8. Addendum: state after the report (2026-11-19, 11:37 UTC)

Sections 1–7 are unchanged and record the state at report time. This addendum covers later work on the same branch. When it was written, HEAD was still `7a8a170` and nothing was staged, committed or pushed; section 9 records what happened afterwards.

- **SLA dashboard restoration: complete.** `src/lib/sla-dashboard.ts`, `src/hooks/use-sla-dashboard.ts` and the refactored `src/routes/sla.tsx` were restored from commit `c66409c`, and `HOUR_IN_MS` is exported from `src/lib/sla-utils.ts` as in that commit.
  - F19 compatibility: a narrow `SlaStageRow` (`Pick<ApprovalStageRow, …>` without `workflow_revision`) is used by the module and the hook. The dashboard query is unchanged and still works without the F19.2 migrations.
  - `src/lib/sla-dashboard.test.ts` gains `workflow_revision: 1` in its stage fixture; no assertion changed.
- **F19.5.2 notes corrected.** The `invalid_created_at` and `decision_before_creation` observability notes in `verification/f19_5_2_metric_verification.sql` now reflect F19.5.4 and F19.5.4.1. This supersedes the "Documented, not changed" row in §5. Only the note text changed; no query, expected value or audit figure did.
- **Repository checks at that time:**
  - `npx vitest run`: 40 files; 1317 tests pass and 12 are skipped. The 12 skipped tests are the F19.5.5 database-mode tests, which run only when `F19_5_5_DB_DIR` is set (§3.5).
  - `npx tsc --noEmit`: 0 errors. The 14 errors in §6.4 are resolved.
- **Existing local database: not modified.** No database command or migration was run for the restoration or these checks.
- **F19.5.4.1 migration renumbered.** The security hardening migration was renamed from `20261119120000_f19_5_4_1_security_hardening.sql` to `20261119120100_f19_5_4_1_security_hardening.sql`, with identical content, to avoid a version collision with the upstream F21 migration `20261119120000_f21_rbac_backend_authorization.sql`. The order is now F21 (`20261119120000`), F19.5.4.1 (`20261119120100`), F19.5.4.2 (`20261119130000`). References in this report use the new name, except the `git status` snapshot in §7, which is kept as recorded. The disposable-database results in this report were produced under the old number.

## 9. Addendum: commits and later verification (2026-11-19)

Sections 1–8 are unchanged records of earlier states. This section records what followed.

**Commits.** The accumulated work was committed in this order on `feature/f19-efficiency-analytics`. Nothing has been pushed. When this section was written, HEAD was `a0f25d8`, and this report was not yet committed.

| Commit    | Subject                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `5139879` | refactor(sla): restore dashboard refactor from c66409c, typed with SlaStageRow |
| `0c7a96d` | feat(f19.2): decision status guard                                             |
| `6d6f345` | feat(f11): restore notification verification compatibility                     |
| `6e92dc9` | feat(f19.5.4): harden workflow data and event provenance                       |
| `a6b2a01` | fix(f19.5.4): renumber security hardening migration after F21                  |
| `a0f25d8` | feat(f19.4): add efficiency metrics calculation engine                         |

**Repository checks.**

- After `a0f25d8`: `npx vitest run` passed 1,341 tests with 12 skipped (41 files), and `npx tsc --noEmit` reported 0 errors.
- With the F19.5.5 changes below (13 more tests): 1,354 passed and 12 skipped (41 files); `npx tsc --noEmit` reports 0 errors. The 12 skipped tests are still the F19.5.5 database-mode tests.

**F19.5.4.1 / F19.5.4.2 disposable runner, under the new migration number.** `verification/f19_5_4_1_disposable_db.sh` was run again after the renumbering, with the local stack's image. It applied `20261119120100_f19_5_4_1_security_hardening.sql` and `20261119130000_f19_5_4_2_event_provenance.sql`, and found the request and event snapshots unchanged. F19.5.4.1 passed sections 1–8 and F19.5.4.2 passed sections 1–5. `f19_2_status_guard.sql`, `f19_2_regression.sql` and `f19_2_status_guard_concurrency.sh` passed, and the runner exited 0. The disposable container was removed, and the existing local database was unchanged (13 migrations, latest `20261119072711`, 7 requests, 9 stages, 29 workflow events). The upstream F21 migration is not on this branch, so the order F21, F19.5.4.1, F19.5.4.2 was not exercised.

**F11 notification verification.** The revised `verification/f11-notifications.sql`, including its approval and rejection checks, passed against the local development database. It ran in one transaction that applied the F11 drizzle migrations and ended in `ROLLBACK`. Afterwards, the temporary F11 objects and all fixture rows were absent, and the database totals matched the baseline. The command and results are in `docs/F11_Verification_Report.md`.

**F19.5.5 changes.**

- Scenario T-DS: a decisive stage completed in a different period than an earlier stage, by `stage_order` and by revision. A mutation check that placed decisions in the first stage's period, which no earlier F19.5.5 scenario detected, now fails on T-DS.
- `flattenSql` is strict: it rejects unrecognized or malformed result rows, requires every value the F19.5.2 SQL must report, and checks the approval denominator.
- `db/seed.sql` refuses to run unless `-v disposable=1` is set; `db/run.sh` passes it. The guard was checked in a new throwaway container with no project schema: with the variable unset, `0` or `yes`, psql stopped with the refusal before any other statement; with `1`, the guard passed.

**F19.5.5 database mode has not been rerun** since the migration was renumbered to `20261119120100`. The saved output of the second database-mode run was re-parsed with the strict parser, without a database: 72 tests passed, with 0 mismatches.

**Existing local database.** None of the work in this section applied a migration to it or changed its data. `20261119120100` and `20261119130000` are still not applied there.

**Still required after `main` is merged** (which brings upstream F21, `20261119120000_f21_rbac_backend_authorization.sql`): rerun the F19.5.4 disposable runner, F19.5.5 database mode and the F11 suite, then the full test suite, type check and lint.

## 10. Addendum: verification after integrating `origin/main` (2026-11-19)

Section 9 is kept as written. Its statements that the F21 order was not exercised, that F19.5.5 database mode had not been rerun, and that reruns were still required after merging `main` describe the state before this section. The runs below cover those items.

**Integration.** `origin/main` was merged into `feature/f19-efficiency-analytics` as merge commit `6d7aaa7`, with no conflicts. This brought in the upstream F21 migration `20261119120000_f21_rbac_backend_authorization.sql`. `95312c7` (test(f19.5): add independent metric verification suite) was committed before the merge. Nothing has been pushed. Every result below was produced at HEAD `6d7aaa7`.

**Migration order.** `supabase/migrations` now holds 16 files. Sorted by version, the last four are `20261119072711_f19_2_decision_status_guard`, `20261119120000_f21_rbac_backend_authorization`, `20261119120100_f19_5_4_1_security_hardening` and `20261119130000_f19_5_4_2_event_provenance`. Each disposable run below applied all 16 in that order, each in its own transaction, so F21 was applied before both F19.5.4 migrations.

**Database safety.** All four database runs (Phases 2A–2D) used a new disposable container started from the local stack's Supabase Postgres image, with a random password, no port mapping and no volume, accessed only through `docker exec`, and removed on exit. The local development database and the hosted database were not connected to or changed. No persistent database URL or credential was used.

### Phase 1: repository checks

- `npx vitest run`: 1,376 passed, 0 failed, 12 skipped (43 files). The 12 skipped tests are the F19.5.5 database-mode tests, which run only when their output directory is supplied (Phase 2B).
- `npx tsc --noEmit`: exit 0.
- Type check of the verification TypeScript (4 files, scratch tsconfig): 0 errors.
- ESLint: 953 errors and 10 warnings, all inherited. The pre-merge branch had 939 errors, upstream `main` 952 and the merge 953. No file has more problems than it had in both parents.
- Prettier: the remaining warnings are in files inherited from upstream, plus existing formatting in `docs/F11_Verification_Report.md`.
- `git diff --check`: clean.

### Phase 2A: F19.5.4.1 / F19.5.4.2 disposable runner

`verification/f19_5_4_1_disposable_db.sh`, container `f19-5-4-1-disposable-60488`. All 16 migrations applied in the order above. F19.5.4.1 passed sections 1–8, F19.5.4.2 passed sections 1–5. `f19_2_status_guard.sql`, `f19_2_regression.sql` and `f19_2_status_guard_concurrency.sh` passed, and the runner reported `F19.5.4.1 and F19.5.4.2 disposable-database verification passed.` The container was removed.

This is the first run of the F19.5.4 checks with F21 applied before them.

### Phase 2B: F19.5.5 database mode

`verification/f19_5_5/db/run.sh`, container `f19-5-5-disposable-60891`. The runner recorded 16 migrations, latest `20261119130000`, and found the F19.2 and F19.5.4 triggers present. It seeded and exported scenarios S5 (6 requests, 6 stages), S58 (1 request, 3 stages) and SX (15 requests, 15 stages), and ran the independent F19.5.2 SQL for October, November and December 2026.

- Vitest in database mode: 72 of 72 tests passed (1 file).
- The strict parser accepted all 729 result rows (81 per SQL run; 3 scenarios × 3 periods).
- 69 comparison runs, 14,997 comparisons, 0 mismatches. 1,062 of the comparisons were SQL results against hand-computed values.
- 12 fresh output files were written (3 exports and 9 SQL result files). The container was removed before vitest ran.

This is the first database-mode run since the F19.5.4.1 migration was renumbered to `20261119120100`, and the first with F21 applied. The outdated database-mode status statement in `verification/f19_5_5/README.md` has since been corrected to reflect the successful Phase 2B rerun.

### Phase 2C: F11 notification suite

Scratchpad helper (not a repository file), container `f11-phase2c-disposable-61325`. After the 16 migrations, the documented F11 wrapper ran unchanged against the container: one transaction applying `drizzle/migrations/0001` and `0002`, then `verification/f11-notifications.sql` with its `BEGIN;` line removed and its final `ROLLBACK;` kept.

- `psql` exited 0 and printed `F11 integration assertions passed`, so none of the suite's 16 failure checks fired. The only warning was the suite's own injected notification failure (`SQLSTATE 23514`).
- After the rollback, the F11 table, function and trigger were absent, and no users, roles, requests, stages, events or fixture users remained (all counts 0, the same as before the run).
- The container was removed.

Details are in `docs/F11_Verification_Report.md`.

### Phase 2D: F12 security checks

Scratchpad helper, container `f12-phase2d-disposable-61577`. The unmodified `verification/f12-security.sql` was run twice:

- Variant A, the 16 `supabase/migrations` only: 5 of 5 checks passed.
- Variant B, the same database after also applying `drizzle/migrations/0000`, `0001` and `0002` in journal order: 5 of 5 checks passed.

The container was removed. In Variant A, the F12 drizzle migration `0000` was not applied, yet authenticated execution of the role helpers was allowed. That suggests a later `supabase/migrations` file, probably F21, grants it. This is an inference: no run isolated which migration is responsible. Details are in `docs/F12_Verification_Report.md`.

### Not covered by these runs

- The hosted database. None of these runs touched it.
- The local development database. It was not connected to during this work; when last inspected (§9) it had 13 migrations and none of F21, `20261119120100` or `20261119130000`.
- CI. Nothing was run on the privileged CI connection.
- Browser or UI checks.
