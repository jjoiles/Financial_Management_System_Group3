# F19.5.5 – Synthetic Scenario Verification of the F19 Efficiency Metrics

Verifies all eight catalog metrics (catalog `2026-11-19.2`) against controlled synthetic scenarios through the public entry point `calculateEfficiencyMetrics({ load, period, prototypeRequests })`. Each load is built by the real F19.3 reader (`readAllPages`) and integrity check (`checkDatasetIntegrity`). The existing local Supabase database is never used.

## Files

| File                                        | Role                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/db-scenarios.json`                | Rows of the database-storable scenarios (S5, S58, SX). One source for the database seed and the TypeScript run.                 |
| `scenarios.ts`                              | TypeScript-only scenarios, periods (F18 builders) and every **hand-derived** expected result.                                   |
| `harness.ts`                                | Loads through the real reader with controllable fetchers; normalises results, expectations and SQL output to comparable leaves. |
| `synthetic-scenarios.test.ts`               | The test suite. Writes `results.json` and `report.md` when `F19_5_5_REPORT_DIR` is set.                                         |
| `db/run.sh`, `db/seed.sql`, `db/export.sql` | Database mode in a disposable container.                                                                                        |

## Method

**Expected values are never produced by the F19.4 calculators.** Two independent sources are used:

1. **Hand calculation** (`scenarios.ts`) for every scenario, written as the arithmetic itself (for example `(6 * 24 + 48) / 7`) from `docs/F19_Efficiency_Metrics.md` sections 3–6 and the section 5 examples.
2. **Independent SQL** for the database-backed scenarios: the unmodified `verification/f19_5_2_metric_verification.sql` runs over the seeded rows for October, November and December 2026. Its output is compared with the hand values (`sql vs hand`). The TypeScript results over the same database rows are also compared with the hand values, so hand, SQL and TypeScript must all agree.

The catalog supplies only the structure of the expectations: which exclusion and flag codes exist, and the recognized queue list from `routing/rules.ts`. It never supplies values.

**Comparison.** Every result is flattened to leaves: status, value, `n`, every recognized queue, the unknown group, population in scope / included (whole dataset), every exclusion and flag code, separate reports, and blocked errors and `issue`. Numbers match within a relative 1e-9; zero and `"no-data"` are different values. A contract check also verifies:

- the catalog version (`2026-11-19.2`, written independently of the constant);
- the report period echo;
- metric identity and order;
- each metric's `metricId`, `catalogVersion` and echoed period;
- that Active Queue Workload has no period and reports the load's read windows as its snapshot.

**Why two kinds of scenario.**

- **Database-backed (S5, S58, SX):** rows PostgreSQL can store under the current constraints. They are seeded into a disposable database built from the full migration history, including `20261119120100_f19_5_4_1_security_hardening.sql` and `20261119130000_f19_5_4_2_event_provenance.sql`. Rows are seeded with triggers bypassed for the seeding transaction only (`session_replication_role = replica`), because they represent history the current triggers would rewrite or refuse: fixed `created_at` values, a decided request with an active stage, a `completed` request. CHECK, UNIQUE and NOT NULL constraints still apply. Rows are exported as the authenticated reviewer (RLS applies) in an `America/New_York` session, so the TypeScript side parses `-04:00` / `-05:00` offsets and microsecond digits.
- **TypeScript-only (T-\*, L-\*):** inputs the database cannot hold (unknown queues, ties, null / fractional / string keys, invalid or reversed timestamps, unrecognized statuses, two active stages per request), browser prototypes, and load-integrity failures. These are built as real F19.3 read results from controlled fetchers and checked against hand calculations only.

## Scenarios

| ID                    | Covers                                                                                                                                                                                                                                                                                                                                                                                                                           | Periods                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| S5                    | Spec §5 worked example A–F: volume, workload snapshot, stage times per queue and pooled, turnaround, approval rate, throughput; orphaned stage C1; `pending_without_stage` F; D created in October and decided in November                                                                                                                                                                                                       | Oct, Nov, Dec                     |
| S58                   | Spec §5.8: amended request H, decisive stage in revision 2, cancelled H2 excluded but inside the turnaround                                                                                                                                                                                                                                                                                                                      | Oct, Nov, Dec                     |
| SX                    | `completed` requests (completed stage counted; active stage orphaned); decision before creation; cancelled decisive stage with no fallback; untracked terminal request; multi-stage rejection across two queues; 0 h stage and 0 h turnaround; stage completing and request created exactly at the period end; created at 23:59:59.999999; sub-ms digits; skipped and cancelled stages; pending requests with and without stages | Oct, Nov, Dec                     |
| T-U1                  | Spec §5.3 / §5.6 unknown queue `procurement`: 38.4 h pooled average, unknown group, `unknown_queue` flag                                                                                                                                                                                                                                                                                                                         | Nov                               |
| T-R                   | Spec §5.2 second snapshot: dept 2, dean 1, research 1, unknown 1; `duplicate_active_stages` 1                                                                                                                                                                                                                                                                                                                                    | Nov                               |
| T-W                   | One request active in two queues; two active rows in one queue; orphan on a rejected request; pending request with only a cancelled stage (not `pending_without_stage`); case-variant queue id; recognized queues at zero; queue total 5 vs 4 distinct requests                                                                                                                                                                  | Nov                               |
| T-D                   | Decisive stage: tie at the highest pair; tie at a lower pair with a unique highest (valid); revision 10 vs 9 compared as integers; null, fractional and string keys; unparseable decision instant                                                                                                                                                                                                                                | Nov                               |
| T-TS                  | Seven invalid `created_at` forms; end before start; null start; date-only end; missing `completed_at`; unrecognized and null status; skipped; equal timestamps; reversed microseconds within one millisecond (0 h); explicit offsets; inclusive start and exclusive end boundaries; an Eastern custom range                                                                                                                      | Oct, Nov, Dec, Eastern 2026-10-31 |
| T-TAT                 | Decision instants across offsets (0 h), a 1 ms decision before creation, and sub-ms digits                                                                                                                                                                                                                                                                                                                                       | Nov                               |
| T-DS                  | Decisive stage completed in another period than an earlier stage (by `stage_order` and by revision): stage times and throughput use each stage's own `completed_at` (October), turnaround and approval rate use the decisive stage's (November); storable, but TypeScript-only for now                                                                                                                                           |
| T-P                   | Section 5 plus browser prototypes (submitted, approved, unparseable `created_at`): counted only under `prototype_request`                                                                                                                                                                                                                                                                                                        | Nov                               |
| T-EMPTY               | Complete, valid, empty dataset: 0 for counts, no-data for statistics                                                                                                                                                                                                                                                                                                                                                             | Nov                               |
| T-ALLEXCL             | Every in-scope record excluded: Volume 0 (valid zero), statistics no-data                                                                                                                                                                                                                                                                                                                                                        | Nov                               |
| L-REQ-ACCESS          | Request read fails with 42501: six metrics blocked with `access`; throughput calculated                                                                                                                                                                                                                                                                                                                                          | Nov                               |
| L-STAGE-UNAVAILABLE   | Stage read fails (network): seven metrics blocked with `unavailable`; volume calculated                                                                                                                                                                                                                                                                                                                                          | Nov                               |
| L-STAGE-ROWCAP        | §5.7 row cap: count mismatch, `stage_read_incomplete`                                                                                                                                                                                                                                                                                                                                                                            | Nov                               |
| L-STAGE-ACTIVE-ONLY   | §5.7 workload case: only active stages served, `stage_read_incomplete`                                                                                                                                                                                                                                                                                                                                                           | Nov                               |
| L-STAGE-DUPLICATE-KEY | A page repeats a row: `stage_read_incomplete`                                                                                                                                                                                                                                                                                                                                                                                    | Nov                               |
| L-REQ-FIELD           | §5.7: `created_at` not selected, `request_field_missing`                                                                                                                                                                                                                                                                                                                                                                         | Nov                               |
| L-STAGE-FIELD         | `workflow_revision` not selected, `stage_field_missing`                                                                                                                                                                                                                                                                                                                                                                          | Nov                               |
| L-NOT-LOADED          | §5.7: a stage whose request is not loaded; volume and throughput (including that stage) calculated, the rest blocked                                                                                                                                                                                                                                                                                                             | Nov                               |
| L-BOTH-FAILED         | Both reads fail; only the first failure (requests) is classified                                                                                                                                                                                                                                                                                                                                                                 | Nov                               |
| L-CANCELLED           | Aborted before the load: all eight `cancelled`                                                                                                                                                                                                                                                                                                                                                                                   | Nov                               |

Additional checks:

- **Determinism:** page sizes 1, 2, 7 and 500, and reversed or rotated row order, give identical leaves for every complete scenario.
- **Two properties:** queue totals vs distinct requests (T-W), and stage decisions vs requests in throughput (S5).
- **Programming errors:** repeated ids in a supplied load throw, and an invalid period throws a `RangeError` even for a cancelled load.
- **Strict SQL parsing:** `flattenSql` accepts only F19.5.2 result rows it recognizes or lists as informational (with their fixed text checked), requires every value the SQL must report and the final `ALL` summary row, and checks that the approval denominator equals A + R. Anything else throws a `SqlOutputError` naming the row, so a format change cannot silently shrink the comparison. Its own tests use a generated output in the SQL's row format.
- **Disposable-only seed:** `db/seed.sql` refuses to run unless `-v disposable=1` is set (an unset or any other value stops it with an error before any statement); `db/run.sh` passes it.

## Results

The latest runs, at the time of F19.5.5:

| Source                                       | Runs | Leaf comparisons | Mismatches |
| -------------------------------------------- | ---- | ---------------- | ---------- |
| TypeScript vs hand                           | 31   | 3,677            | 0          |
| Determinism                                  | 12   | 7,680            | 0          |
| Queue sum / throughput properties            | 2    | 4                | 0          |
| Database export (fixture instants preserved) | 3    | 218              | 0          |
| SQL vs hand                                  | 9    | 1,026            | 0          |
| TypeScript (database rows) vs hand           | 9    | 1,404            | 0          |

A mutation check was run on a copy of `scenarios.ts` with five values deliberately changed. It failed on exactly the 11 runs that use those values; six of them come from one mutation, because the load-gating scenarios reuse the §5 Volume expectation.

No discrepancy was found between the specification examples, the catalog and the implementation.

**Later changes (after the runs above).** Scenario T-DS was added, `flattenSql` was made strict, and `db/seed.sql` gained its disposable-only guard. In TypeScript mode the suite then had 60 passing tests and 12 skipped database-mode tests. The saved output of the second database-mode run was re-parsed with the strict parser (no database involved): 72 tests passed, with 1,062 SQL-vs-hand comparisons and 0 mismatches; the increase from 1,026 is the stage-time unknown group, which is now compared. A new database-mode run has not been made since the F19.5.4.1 migration was renumbered to `20261119120100`.

### Observations (not discrepancies)

- **§5.7, `request_field_missing`.** The bullet names Request Volume, Request Turnaround Time and Approval Rate as blocked. The catalog (§3.3 table: "all seven" for Active Queue Workload and Stage Processing Time) and the implementation also block those two metrics, because they require a complete request read. The bullet is not exhaustive; it could say so.
- **Microsecond-reversed instants.** A stage whose `completed_at` is earlier than `started_at` only below the millisecond (T-TS s3) is a valid 0 h duration. That follows from the documented millisecond precision (§3.1) and matches the F19.5.2 SQL.
- **Both reads failed.** Queue Throughput is blocked by `stage_read_failed` with `issue` null, because F19.3 classifies only the first failed read (requests). This is documented in §8.1 and `gateMetricLoad`.

## Coverage gaps

- **Not exercised:** PostgREST, Auth, `loadEfficiencyDataset` itself and its retry policy. Loads come from the real reader with controlled fetchers or a database JSON export; the retry policy is covered by `efficiency-data-loader.test.ts`.
- **RLS:** only the reviewer's view is exported. Requester-scoped visibility of synthetic data was not exercised (see F19.5.4).
- **No SQL cross-check for TypeScript-only scenarios:** the database cannot store them, so they rely on hand calculation alone.
- **Load integrity:** `count_unavailable`, `max_pages_exceeded`, `page_overflow`, `out_of_order`, `invalid_key` and concurrent writes during a read are covered by the F19.3 unit tests, not here.
- **Periods:** only calendar months and Eastern custom ranges are used; fiscal and academic periods are not.
- **Prototypes:** ownership scoping is the caller's responsibility and cannot be tested at this layer.
- **Out of scope:** the §5.5 dashboard-formula contrast is not an F19 metric. Large-volume performance is not tested.

## Reproduction

TypeScript mode (no database; part of the normal suite):

```sh
npx vitest run verification/f19_5_5
F19_5_5_REPORT_DIR=<dir> npx vitest run verification/f19_5_5   # also writes results.json and report.md
```

Database mode (Docker; a disposable container from the local stack's Postgres image, never the local database):

```sh
bash verification/f19_5_5/db/run.sh "$(docker inspect <local-db-container> --format '{{.Image}}')" <output-dir>
```

The runner prints the migration list, confirms the F19.2 and F19.5.4 triggers exist, seeds and exports each database scenario, runs the F19.5.2 SQL for each period, stops the container, and runs the suite with `F19_5_5_DB_DIR` and `F19_5_5_REPORT_DIR` set.
