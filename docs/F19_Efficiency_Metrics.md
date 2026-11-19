# F19.1 – Efficiency Metrics and Formulas

**Feature:** F19 Efficiency & Process Analytics
**Sub-issue:** F19.1 – Define Efficiency Metrics and Formulas
**Builds on:** F16 – SLA stage tracking, F18 – Temporal Filtering (reporting periods, time zones, cross-period filtering)

## 1. Purpose and scope

F19.1 defines six efficiency and process metrics precisely enough that later work can calculate, load and verify them without reinterpreting the rules:

1. Request Volume
2. Active Queue Workload
3. Stage Processing Time (average and median)
4. Request Turnaround Time (average and median)
5. Approval Rate
6. Queue Throughput

It delivers:

- this specification, and
- a declarative, browser-safe metric catalog, `src/lib/efficiency-metrics.ts`, with tests in `src/lib/efficiency-metrics.test.ts`.

The catalog **describes** metrics. It contains no calculation, aggregation or data-loading code.

Out of scope:

| Topic                                                             | Where it belongs  |
| ----------------------------------------------------------------- | ----------------- |
| Database tables, migrations, triggers, functions and RLS policies | F19.2             |
| Workflow-event data integrity and write permissions               | F19.2             |
| Data loaders, complete reads and workload capture                 | F19.3             |
| Aggregation functions that calculate the metrics                  | F19.4             |
| Validation evidence, traceability matrix update                   | F19.5             |
| Routes, dashboards and other UI changes                           | Not part of F19.1 |
| Individual reviewer assignment or person-level workload           | Not planned       |
| Changes to F18 reporting periods, time zones or filtering         | Not part of F19.1 |
| Replacing the existing Analytics page's mock or hardcoded figures | Not part of F19.1 |

## 2. Module layout

| File                                     | Role                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/lib/efficiency-metrics.ts`          | Metric catalog, load-integrity errors, data-quality codes, known limitations, version       |
| `src/lib/efficiency-metrics.test.ts`     | Catalog definition tests, documentation agreement, migration-history schema checks, imports |
| `docs/F19_Efficiency_Metrics.md`         | This specification                                                                          |
| `src/lib/efficiency-data.ts`             | F19.3 pure data layer: column lists, row types, paginated reader, integrity check (§8.1)    |
| `src/lib/efficiency-data.test.ts`        | Tests for the pure data layer                                                               |
| `src/lib/efficiency-data-loader.ts`      | F19.3 Supabase-bound `loadEfficiencyDataset` and its retry policy (§8.1)                    |
| `src/lib/efficiency-data-loader.test.ts` | Loader tests against controlled fakes of the existing clients                               |

F19.4 calculation modules (section 8.3). Each has a `.test.ts` file beside it except `efficiency-classification.ts`: its load-gating tests are in `efficiency-population.test.ts` and its classification-engine tests in `efficiency-population-classification.test.ts`. `efficiency-calculation.test.ts` tests the shared period check and per-queue output directly; the calculator tests also exercise them.

| File                                          | Role                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/lib/efficiency-stats.ts`                 | `hoursBetween`, `average`, `median` and `NO_DATA`: calendar hours and statistics, no metric knowledge     |
| `src/lib/efficiency-population.ts`            | Dataset indexing, decisive-stage selection, recognized queue IDs and queue grouping                       |
| `src/lib/efficiency-classification.ts`        | Per-metric load gating, the catalog-driven classification engine, its predicates, flag rules and scopes   |
| `src/lib/efficiency-calculation.ts`           | Steps every calculator shares: period check, indexing a ready load, catalog anchor test, per-queue output |
| `src/lib/efficiency-request-volume.ts`        | `calculateRequestVolume`                                                                                  |
| `src/lib/efficiency-stage-processing-time.ts` | `calculateStageProcessingTime` (average and median)                                                       |
| `src/lib/efficiency-queue-throughput.ts`      | `calculateQueueThroughput`                                                                                |
| `src/lib/efficiency-decision-metrics.ts`      | `calculateRequestTurnaroundTime` (average and median) and `calculateApprovalRate`, sharing one population |
| `src/lib/efficiency-active-queue-workload.ts` | `calculateActiveQueueWorkload` and its `pending_without_stage` report                                     |
| `src/lib/efficiency-analytics.ts`             | Public entry point `calculateEfficiencyMetrics`: every catalog metric from one load (section 8.3)         |
| `src/lib/efficiency-analytics.test.ts`        | Integration tests: catalog coverage, independent gating, period and snapshot handling, module layering    |

Dependency direction (arrows point to the module being imported):

```
efficiency-metrics.ts ──▶ deep-freeze.ts   (no imports)

efficiency-analytics.ts                          entry point; nothing imports it
  ──▶ efficiency-request-volume.ts, efficiency-stage-processing-time.ts,
      efficiency-queue-throughput.ts, efficiency-decision-metrics.ts,
      efficiency-active-queue-workload.ts        calculators; never import each other
        ──▶ efficiency-calculation.ts             shared calculation steps (every calculator)
        ──▶ efficiency-classification.ts          gating and classification (every calculator)
        ──▶ efficiency-population.ts              decisive stage (efficiency-decision-metrics.ts only)
        ──▶ efficiency-stats.ts                   hours and statistics (efficiency-stage-processing-time.ts,
                                                  efficiency-decision-metrics.ts)

efficiency-calculation.ts     ──▶ efficiency-classification.ts (types only), efficiency-population.ts
efficiency-classification.ts  ──▶ efficiency-population.ts, efficiency-stats.ts
efficiency-population.ts, efficiency-stats.ts     no other F19.4 module
Every layer may also import efficiency-metrics.ts, F19.3 types from efficiency-data.ts,
F18 (time-zones.ts, reporting-periods.ts) and routing/rules.ts.
```

- The F19.4 modules are pure and browser-safe. None imports Supabase, React or `efficiency-data-loader.ts`, and none imports a module above it. `efficiency-analytics.test.ts` checks the layering for every F19 module.

- The catalog imports only `deep-freeze.ts`. It does not import React, Supabase clients, routes or F18 modules.
- F18 modules (`time-zones.ts`, `reporting-periods.ts`, `reporting-period-config.ts`, `date-range-filter.ts`) and `deep-freeze.ts` must not import the catalog. A test checks both directions.
- The catalog exports no functions. A test checks this, so calculation logic cannot be added here by accident.
- The F19.3 modules depend on the catalog, never the reverse. `efficiency-data.ts` imports the catalog's constants and types and the shared `classifyRequestReadError`, and only types from the generated Supabase types and `approval-stage-client.ts`. `efficiency-data-loader.ts` is the only F19 module that imports the Supabase clients.

Catalog exports:

| Export                                                                               | Content                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `EFFICIENCY_METRICS_VERSION`, `VERSION_BUMP_TRIGGERS`                                | Catalog version and the changes that require a bump (section 9)                     |
| `EFFICIENCY_METRIC_FAMILIES`                                                         | The six approved metrics                                                            |
| `EFFICIENCY_METRIC_IDS`                                                              | Eight stable identifiers (the average and median variants are separate)             |
| `EFFICIENCY_METRICS`                                                                 | Definitions keyed by identifier                                                     |
| `SOURCE_FIELDS`                                                                      | The only database columns a metric may reference; each one is used                  |
| `DECISIVE_STAGE_ORDERING`                                                            | `(workflow_revision, stage_order)`: how the decisive stage is chosen                |
| `TERMINAL_REQUEST_STATUSES`, `PENDING_REQUEST_STATUSES`, `EXCLUDED_REQUEST_STATUSES` | `approved, rejected` / `submitted, under_review` / `completed`                      |
| `APPROVAL_STAGE_STATUSES`                                                            | `active, completed, skipped, cancelled`: the stage statuses allowed by the database |
| `UNKNOWN_QUEUE_GROUP`                                                                | The group for unrecognized queue IDs (`unknown`)                                    |
| `LOAD_INTEGRITY_PRECONDITION`, `LOAD_INTEGRITY_ERROR_CODES`, `LOAD_INTEGRITY_ERRORS` | Load-integrity rule and the errors that block calculation (section 3.3)             |
| `STAGE_READ_COVERAGE`                                                                | Which stage records each stage read must return (section 3.3)                       |
| `TRACKED_TERMINAL_POPULATION`                                                        | The shared turnaround and approval-rate population (section 4.4)                    |
| `STATISTIC_DEFINITIONS`                                                              | Average and median definitions                                                      |
| `DATA_QUALITY_RULES`, `DATA_QUALITY_CODES`, `DATA_QUALITY_CHECKS`                    | Precedence rules and record-level codes (section 6)                                 |
| `KNOWN_LIMITATION_IDS`, `KNOWN_LIMITATIONS`                                          | Known data limitations and what resolves them (section 7)                           |

Each metric definition has: `id`, `family`, `name`, `definition`, `formula`, `statistic`, `unit`, `groupings`, `emptyResult`, `sources`, `requiredReads`, `stageReadCoverage`, `loadIntegrityErrors`, `period`, `population`, `flags`, `separateReports`, `calculationRules` and `limitations`. Everything is deeply frozen.

## 3. Conventions for every metric

### 3.1 Time

- **Calendar hours.** A duration is elapsed milliseconds / 3,600,000. There are no business-hours, weekend or holiday adjustments.
- **Full precision.** Calculations keep full precision. Values are rounded only for display, and the display layer chooses the precision.
- **Timestamps** are parsed with the F18 rules (`toValidInstant` in `time-zones.ts`): full ISO-8601 timestamps with an offset, such as Supabase's `2026-11-18T12:34:56.123456+00:00`. Date-only values such as `submittedAt` are never used.

### 3.2 Reporting periods

Periods are F18 `PeriodBounds` and are **half-open**: `startUtc <= instant < endExclusiveUtc`. An instant exactly on a boundary belongs to the later period.

| Period kind    | Boundaries in    | Source                                                       |
| -------------- | ---------------- | ------------------------------------------------------------ |
| Fiscal         | UTC              | `getFiscalYearPeriod`, `getFiscalQuarterPeriod`              |
| Calendar month | UTC              | `getCalendarMonthPeriod`                                     |
| Academic       | America/New_York | `getAcademicPeriodByKey` and the F18.2 configuration         |
| Custom range   | America/New_York | `validateCustomDateRange` with `CUSTOM_DATE_RANGE_TIME_ZONE` |

F19 does not change these conventions. `filterByPeriod(rows, bounds, accessor)` in `date-range-filter.ts` selects rows by any anchor instant.

Each metric is assigned to a period by one **anchor** instant:

| Metric                  | Anchor                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| Request Volume          | `financial_requests.created_at`                                          |
| Active Queue Workload   | None: a current snapshot                                                 |
| Stage Processing Time   | `approval_stage_tracking.completed_at`                                   |
| Request Turnaround Time | Decision instant: `completed_at` of the request's decisive stage (§3.10) |
| Approval Rate           | Decision instant (same as turnaround)                                    |
| Queue Throughput        | `approval_stage_tracking.completed_at`                                   |

Completion-based anchors mean a closed period's values do not change as later work finishes. They also mean Volume and the decision metrics count **different requests** for the same period: a request created in October and decided in November is in October's volume and November's turnaround.

### 3.3 Load integrity

Load integrity is checked before anything else:

> Every read a metric requires must succeed with complete row coverage and every required field. Complete row coverage means every row the reader is permitted to see, across all pages, within the metric's read coverage: for approval_stage_tracking, every stage record with the statuses given by the metric's stageReadCoverage, for every supplied request when requests are also read; and every supplied stage's request present in the request read. Every required field means every source field the metric lists present on every returned row. A null value is present and is judged by the data-quality conditions; an absent field is missing. If any required read fails, is partial or is missing a required field, the metric is not calculated and its result is a load-integrity error that blocks calculation: never a zero-valued metric, never no-data, and never a data-quality exclusion. Data-quality codes describe individual records of a complete dataset only.

A required read is therefore complete only when it has both:

- **complete row coverage:** all visible rows, all pages, and for stage reads the statuses the metric's `stageReadCoverage` requires; and
- **every required field:** each source field the metric lists (section 4) on every returned row.

A load-integrity error describes the **dataset**; a data-quality code (section 6) describes one **record** in a complete dataset. The two sets of codes never overlap. A field that is **absent** from a returned row (for example, a column that was not selected) is a load or schema error. A field that is present with a **null** or invalid value is a record-level data-quality question: a missing `created_at` column is `request_field_missing`, while an unparseable `created_at` value is `invalid_created_at`.

| Code                       | Reads                                           | Meaning                                                                                                                      |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `request_read_failed`      | `financial_requests`                            | The read returned an error, including a permission error, or did not complete                                                |
| `request_read_incomplete`  | `financial_requests`                            | The read returned only part of the visible rows, e.g. a page or row limit                                                    |
| `request_field_missing`    | `financial_requests`                            | A returned row lacks a required source field, e.g. the column was not selected                                               |
| `stage_read_failed`        | `approval_stage_tracking`                       | The read returned an error, including a permission error, or did not complete                                                |
| `stage_read_incomplete`    | `approval_stage_tracking`                       | The read returned only part of the visible rows, did not cover every supplied request, or omitted stage statuses it requires |
| `stage_field_missing`      | `approval_stage_tracking`                       | A returned row lacks a required source field, e.g. the column was not selected                                               |
| `stage_request_not_loaded` | `financial_requests`, `approval_stage_tracking` | A supplied stage's request is not in the supplied request dataset: the two reads are inconsistent (see below)                |

`stage_request_not_loaded` means the request was **not present in the supplied dataset**. It does not necessarily mean the database relationship is broken: `request_id` is a `NOT NULL` foreign key with `ON DELETE CASCADE`, and a stage is readable exactly when its request is. It blocks calculation like any other load-integrity error.

Required reads per metric (`stageReadCoverage` values are defined in `STAGE_READ_COVERAGE`):

| Metric                  | Required reads                                  | Stage read coverage   | Load-integrity errors                              |
| ----------------------- | ----------------------------------------------- | --------------------- | -------------------------------------------------- |
| Request Volume          | `financial_requests`                            | —                     | request read failed, incomplete or missing a field |
| Active Queue Workload   | `financial_requests`, `approval_stage_tracking` | `all-statuses`        | all seven                                          |
| Stage Processing Time   | `financial_requests`, `approval_stage_tracking` | `all-statuses`        | all seven (request status detects orphans)         |
| Request Turnaround Time | `financial_requests`, `approval_stage_tracking` | `all-statuses`        | all seven                                          |
| Approval Rate           | `financial_requests`, `approval_stage_tracking` | `all-statuses`        | all seven                                          |
| Queue Throughput        | `approval_stage_tracking`                       | `non-active-statuses` | stage read failed, incomplete or missing a field   |

- `all-statuses`: every `approval_stage_tracking` record of any status (active, completed, skipped or cancelled) for every request in the supplied request dataset. A read of only active stages is incomplete.
- `non-active-statuses`: every record whose status is not active. Active stages may also be returned; they are outside the metric's scope.

**Active Queue Workload requires `all-statuses`.** It needs every stage record of every request in scope, regardless of status, to tell whether a pending request has any stage records at all. A read of only active stages would report a pending request whose stages are all completed or skipped as `pending_without_stage`; under the precondition that read is `stage_read_incomplete` and blocks the metric instead.

### 3.4 Sources

- Only `financial_requests` (`id`, `status`, `created_at`) and `approval_stage_tracking` (`request_id`, `workflow_revision`, `stage_order`, `queue_id`, `status`, `started_at`, `completed_at`) are used.
- `approval_stage_tracking.id` is not a metric source. F19.3 loaders select it only as the keyset pagination key.
- `financial_requests.updated_at` is never used. Triggers update it for changes unrelated to the workflow, such as metadata and attachment sync.
- `workflow_events` is **not** a source, including for outcomes. Since F19.5.4.2 a client can no longer write a database-generated event type or `source`, but client events remain client-authored and events stored earlier cannot be shown to be database-generated (`docs/F19_Security_Hardening.md`).

### 3.5 Request statuses

| Group    | Statuses                    | Treatment                                                                                                                             |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pending  | `submitted`, `under_review` | Awaiting a decision                                                                                                                   |
| Terminal | `approved`, `rejected`      | The only F19 outcomes                                                                                                                 |
| Excluded | `completed`                 | Excluded from turnaround and approval rate and counted under the `completed_status` data-quality exclusion; never treated as approved |

No code path sets `completed` today. How it affects each metric:

- **Request Volume:** included, like every status.
- **Request Turnaround Time and Approval Rate:** excluded and counted under `completed_status`, a data-quality exclusion. The request is not retained as a flagged record.
- **Active Queue Workload:** an active stage of a `completed` request is an inconsistent stage, excluded under `orphaned_active_stage`.
- **Stage Processing Time and Queue Throughput:** a `completed` request's completed stages still contribute. Request status only matters for active stages.

A test checks that these three groups exactly cover the database enum.

### 3.6 Records that are never real data

- **Prototype requests** saved in the browser (`EnrichedRequest.prototype === true`) are excluded under `prototype_request` wherever they fall inside a request population (section 6).
- **Mock data** (`src/lib/mock-data.ts`, `getReportingWindowData` in `analytics-utils.ts`) is never an input.

### 3.7 Queue groups

Queue groupings have one group per recognized `QueueId` in `src/lib/routing/rules.ts`, plus the **unknown** group (`UNKNOWN_QUEUE_GROUP`). A stage whose `queue_id` is not recognized:

- counts in the unknown group, never in a recognized queue;
- counts in overall values: pooled Stage Processing Time and overall Queue Throughput;
- is flagged under `unknown_queue`, which never removes it from the value.

### 3.8 Statistics

- **Average:** the arithmetic mean, Σx / n. Groupings pool individual values, so an overall average is never an average of per-queue averages.
- **Median:** the middle value of the values sorted in ascending order. When n is even, it is the mean of the two middle values.
- **Empty input:** when n = 0 in a complete dataset, both are **no-data** (undefined), never 0. A failed or partial load is a load-integrity error, not an empty input.

### 3.9 Scope of visibility

RLS shows admin, reviewer and leadership users every request and stage, and requesters only their own. Institution-wide results are therefore meaningful only for those three roles.

### 3.10 Workflow revisions and the decisive stage

F19.2 added `workflow_revision` to `financial_requests` and `approval_stage_tracking`. An amendment (`f19_amend_request_workflow`) cancels the request's active stage, increments the revision, and restarts the approval chain at `stage_order` 1 of the new revision. Stages of earlier revisions are kept as history.

Only requests awaiting a decision (`submitted`, `under_review`) can be amended, and `approved`, `rejected` and `completed` are final (section 8.2). An amendment therefore always replaces an approval chain that had not finished; it never reopens a recorded decision or moves it out of a closed reporting period.

- A request's **decisive stage** is the stage with the highest `(workflow_revision, stage_order)` pair (`DECISIVE_STAGE_ORDERING`): the highest `workflow_revision` first, then the highest `stage_order` within it. `stage_order` alone is not enough, because a cancelled stage 2 of revision 1 has a higher `stage_order` than a decisive stage 1 of revision 2.
- Both fields are compared as integers, not as text, so revision 10 is newer than revision 9. A request has **no decisive stage**, and is excluded as `terminal_stage_invalid`, when two or more of its stages share the highest pair, or when any of its stages has a null or non-integer `workflow_revision` or `stage_order`. An invalid key on any stage counts, because without it the highest pair cannot be known; a tie below the highest pair does not change which stage is decisive and does not count. The database prevents both (`UNIQUE (request_id, workflow_revision, stage_order)` and `NOT NULL INTEGER` columns), so these cases come only from data that bypassed those constraints.
- Stage records of earlier revisions stay in every stage population. A cancelled stage is excluded as `skipped_or_cancelled_stage`; a completed stage of an earlier revision is a real queue decision and counts in Stage Processing Time and Queue Throughput.
- Turnaround is still measured from the original `financial_requests.created_at`, so for an amended request it includes the time spent in earlier revisions (section 5.8).
- **Decisive stage vs. elapsed time.** Only the decisive stage supplies the decision instant T(r), and condition 6 requires it to be `completed`. A cancelled stage can never be decisive. Its elapsed time still lies between `created_at` and T(r), so it is part of the request's turnaround even though it supplies no decision instant and is excluded from Stage Processing Time and Queue Throughput.

## 4. Metric definitions

Each metric has a **population**: a subject (request or stage), a **scope**, and ordered **conditions**. Records outside the scope are removed first and are not counted. Each remaining record is checked against the conditions in order, and the first condition it fails gives its one primary exclusion code (section 6).

### 4.1 Request Volume — `request_volume`

**Definition:** the number of real financial requests received during a reporting period, regardless of status or outcome.

**Formula:** `Volume(P) = |{ r ∈ financial_requests : r.created_at ∈ P }|`

| Property  | Value                                                    |
| --------- | -------------------------------------------------------- |
| Statistic | count                                                    |
| Unit      | requests                                                 |
| Grouping  | overall                                                  |
| Empty     | 0                                                        |
| Sources   | `financial_requests.id`, `financial_requests.created_at` |
| Anchor    | `financial_requests.created_at`                          |

**Scope:** every supplied request record, in any status (subject: request).

| #   | Condition                                                       | Exclusion code       |
| --- | --------------------------------------------------------------- | -------------------- |
| 1   | The request is a real database request, not a browser prototype | `prototype_request`  |
| 2   | `created_at` is a valid instant                                 | `invalid_created_at` |

**Flags:** none.

**Rules:** each remaining request counts once, whatever its status, including rejected, pending, `completed`, and requests whose workflow failed.

**Limitations:** `created_at_unverified_before_hardening`, `unbounded_reads`, `non_atomic_reads`, `role_scoped_visibility`.

### 4.2 Active Queue Workload — `active_queue_workload`

**Definition:** the number of distinct requests currently waiting for a decision in each approval queue.

**Formula:** `Workload(q, now) = |{ distinct s.request_id : s.status = 'active' ∧ s.queue_id = q ∧ request(s).status ∈ {submitted, under_review} }|`

| Property  | Value                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------ |
| Statistic | distinct count                                                                                   |
| Unit      | requests                                                                                         |
| Grouping  | per queue: each recognized `QueueId` plus the unknown group                                      |
| Empty     | 0 per recognized queue                                                                           |
| Sources   | `approval_stage_tracking.request_id`, `.queue_id`, `.status`; `financial_requests.id`, `.status` |
| Anchor    | None: a snapshot as of the dataset load (its read interval, `non_atomic_reads`)                  |

**Scope:** supplied approval stage records with status `active` (subject: stage).

| #   | Condition                                                    | Exclusion code          |
| --- | ------------------------------------------------------------ | ----------------------- |
| 1   | The stage's request is pending (`submitted`, `under_review`) | `orphaned_active_stage` |

An active stage of an approved, rejected or `completed` request is an inconsistent (orphaned) stage: excluded from workload and reported.

**Flags:** `duplicate_active_stages`, `unknown_queue`.

- `duplicate_active_stages` is a request-level flag on this stage population. It is counted once per pending request that has more than one active stage, not once per stage. All of that request's active stage records stay included; because workload counts distinct `request_id` values per queue, the extra stages add no workload.
- `unknown_queue` is a stage-level flag: the stage counts only in the unknown group.

**Stage read coverage:** `all-statuses`. Every `approval_stage_tracking` record of any status for every supplied request must be read, not only active stages (section 3.3).

**Reported separately:** `pending_without_stage`. Scope: supplied requests with status `submitted` or `under_review` that have **no approval stage records of any status** (subject: request).

| #   | Condition                                                       | Exclusion code      |
| --- | --------------------------------------------------------------- | ------------------- |
| 1   | The request is a real database request, not a browser prototype | `prototype_request` |

**Rules:** each remaining request counts once per queue by distinct `request_id`, including stages past their SLA deadline. Every recognized queue reports a value, 0 when empty. Past workload is not reconstructed: rebuilding it from `started_at` and `completed_at` is unreliable while stage rows can be edited directly and stages can be orphaned.

**Limitations:** `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `stage_constraints_unenforced`, `historical_stage_gaps`, `unbounded_reads`, `non_atomic_reads`, `role_scoped_visibility`.

### 4.3 Stage Processing Time — `stage_processing_time_average`, `stage_processing_time_median`

**Definition:** the calendar time an approval queue takes from the start of a stage to its decision.

**Formulas:**

- `d(s) = (s.completed_at − s.started_at) / 3,600,000 ms`
- `AvgStage(q, P) = Σ d(s) / n` over remaining stages of queue group _q_ with `completed_at ∈ P`
- `MedianStage(q, P) = median of d(s)` over the same stages
- The overall value pools every remaining stage, including unknown-queue stages.

| Property  | Value                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Statistic | average; median                                                                                                                  |
| Unit      | hours                                                                                                                            |
| Grouping  | overall (pooled) and per queue (recognized queues plus unknown)                                                                  |
| Empty     | no-data                                                                                                                          |
| Sources   | `approval_stage_tracking.request_id`, `.queue_id`, `.status`, `.started_at`, `.completed_at`; `financial_requests.id`, `.status` |
| Anchor    | `approval_stage_tracking.completed_at`                                                                                           |

**Scope:** every supplied approval stage record (subject: stage).

| #   | Condition                                                                                                 | Exclusion code               |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | The stage is not an active stage of a request that is no longer pending (approved, rejected or completed) | `orphaned_active_stage`      |
| 2   | The stage is not active                                                                                   | `in_progress_stage`          |
| 3   | The stage is not skipped or cancelled                                                                     | `skipped_or_cancelled_stage` |
| 4   | The stage status is one of `active`, `completed`, `skipped`, `cancelled` (`APPROVAL_STAGE_STATUSES`)      | `unrecognized_stage_status`  |
| 5   | A completed stage has a `completed_at`                                                                    | `stage_missing_completed_at` |
| 6   | `started_at` and `completed_at` are valid instants and `completed_at` is not earlier than `started_at`    | `invalid_stage_timestamps`   |

Condition 1 comes before condition 2, so an orphaned stage is never counted as an ordinary in-progress stage. A stage that passes conditions 1 to 4 has status `completed`; a null or unrecognized status is never treated as completed.

**Flags:** `unknown_queue`.

**Rules:** rejected stages are included, since a rejection is a decision the queue spent time on. Completed stages of requests that are now approved, rejected or `completed` are included; request status affects only active stages. Stages are not split by outcome, because the outcome is not recorded on the stage row (`stage_outcome_not_recorded`).

**Limitations:** `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `stage_constraints_unenforced`, `stage_outcome_not_recorded`, `historical_stage_gaps`, `unbounded_reads`, `non_atomic_reads`, `role_scoped_visibility`.

The existing `queuePerformance` block in `src/routes/sla.tsx` is similar but is not this metric: it is untested and falls back to `started_at` when `completed_at` is missing. F19 does not copy that fallback.

### 4.4 Request Turnaround Time — `request_turnaround_time_average`, `request_turnaround_time_median`

**Definition:** the calendar time from when a request was received to its final approval or rejection.

**Tracked terminal population** (`TRACKED_TERMINAL_POPULATION`, shared with Approval Rate). Scope: requests whose status is `approved`, `rejected` or `completed`; pending requests are outside the population and are not counted (subject: request). A **tracked terminal request** is one that meets every condition:

| #   | Condition                                                                                                                                                                                                                                                                           | Exclusion code                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | The request is a real database request, not a browser prototype                                                                                                                                                                                                                     | `prototype_request`                  |
| 2   | The status is `approved` or `rejected`; `completed` is never treated as approved                                                                                                                                                                                                    | `completed_status`                   |
| 3   | `created_at` is a valid instant                                                                                                                                                                                                                                                     | `invalid_created_at`                 |
| 4   | The request has at least one approval stage record                                                                                                                                                                                                                                  | `untracked_terminal_request`         |
| 5   | None of the request's stages is active                                                                                                                                                                                                                                              | `terminal_request_with_active_stage` |
| 6   | The decisive stage (highest `(workflow_revision, stage_order)`, compared as integers, §3.10) exists, is unique, and has status `completed` and a valid `completed_at`, the decision instant **T(r)**. Ties at the highest pair and null or non-integer keys leave no decisive stage | `terminal_stage_invalid`             |
| 7   | T(r) is not earlier than `created_at`                                                                                                                                                                                                                                               | `decision_before_creation`           |

`f16_record_approval_decision` completes the stage and sets the final status in one transaction with the same timestamp, so `T(r)` is exactly the decision time. It comes only from the stage table, which requesters cannot write.

**Formulas:**

- `TAT(r) = (T(r) − r.created_at) / 3,600,000 ms`
- `AvgTAT(P) = Σ TAT(r) / n` over tracked terminal requests with `T(r) ∈ P`
- `MedianTAT(P) = median of TAT(r)` over the same requests

**Intake gap:** turnaround starts at `created_at`, so it includes the time before stage 1 starts. When every decision went through `f16_record_approval_decision`, each next stage starts at the instant the previous stage completes, so:

```
TAT(r) = (stage1.started_at − created_at) + Σ stage durations
```

F19.5 can use this identity as a consistency check. Direct stage edits (`stage_rows_directly_writable`) can break it, so a mismatch is a data-quality signal, not a calculation error.

**Amended requests:** turnaround still starts at the original `created_at`, so it includes the time spent in earlier workflow revisions before the amendment, not only the final revision's approval chain. The identity above then holds only when the earlier revisions' stages, including the cancelled one, are counted as well (section 5.8).

| Property  | Value                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statistic | average; median                                                                                                                                           |
| Unit      | hours                                                                                                                                                     |
| Grouping  | overall                                                                                                                                                   |
| Empty     | no-data                                                                                                                                                   |
| Sources   | `financial_requests.id`, `.status`, `.created_at`; `approval_stage_tracking.request_id`, `.workflow_revision`, `.stage_order`, `.status`, `.completed_at` |
| Anchor    | Decision instant `T(r)`                                                                                                                                   |

**Flags:** none.

**Limitations:** `created_at_unverified_before_hardening`, `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `historical_stage_gaps`, `unbounded_reads`, `non_atomic_reads`, `role_scoped_visibility`.

`updated_at − created_at` is **not** turnaround, despite the suggestion in `docs/DEBT_AND_RISK.md`.

### 4.5 Approval Rate — `approval_rate`

**Definition:** of the requests that reached a final decision in the period, the fraction that were approved.

**Formula:** `ApprovalRate(P) = A / (A + R)`, where A and R count tracked terminal requests with status `approved` and `rejected` and `T(r) ∈ P`. When `A + R = 0` the result is **no-data**, not 0%.

| Property  | Value                                          |
| --------- | ---------------------------------------------- |
| Statistic | ratio                                          |
| Unit      | fraction from 0 to 1 (display as a percentage) |
| Grouping  | overall                                        |
| Empty     | no-data                                        |
| Sources   | Same as Request Turnaround Time                |
| Anchor    | Decision instant `T(r)` (same as turnaround)   |

**Population:** exactly the tracked terminal population of section 4.4, including `decision_before_creation`:

| #   | Condition                                                                                                                                                                                                                                                                           | Exclusion code                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | The request is a real database request, not a browser prototype                                                                                                                                                                                                                     | `prototype_request`                  |
| 2   | The status is `approved` or `rejected`; `completed` is never treated as approved                                                                                                                                                                                                    | `completed_status`                   |
| 3   | `created_at` is a valid instant                                                                                                                                                                                                                                                     | `invalid_created_at`                 |
| 4   | The request has at least one approval stage record                                                                                                                                                                                                                                  | `untracked_terminal_request`         |
| 5   | None of the request's stages is active                                                                                                                                                                                                                                              | `terminal_request_with_active_stage` |
| 6   | The decisive stage (highest `(workflow_revision, stage_order)`, compared as integers, §3.10) exists, is unique, and has status `completed` and a valid `completed_at`, the decision instant **T(r)**. Ties at the highest pair and null or non-integer keys leave no decisive stage | `terminal_stage_invalid`             |
| 7   | T(r) is not earlier than `created_at`                                                                                                                                                                                                                                               | `decision_before_creation`           |

**Flags:** none.

**Rules:** each request counts once, by its final outcome, whichever stage decided it. `workflow_events` is not used.

**Limitations:** the same as Request Turnaround Time.

**Not the dashboard approval rate.** `calculateAnalyticsSummary().approvalRate` in `src/lib/analytics-utils.ts` divides approved plus completed by **all** requests and returns 0 when there are none. F19 does not reuse or change it.

### 4.6 Queue Throughput — `queue_throughput`

**Definition:** the number of approval-stage decisions each queue completed during the period, including rejections.

**Formula:** `Throughput(q, P) = |{ s : s.queue_id = q ∧ s.status = 'completed' ∧ s.completed_at ∈ P }|`

| Property  | Value                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| Statistic | count                                                                         |
| Unit      | stage decisions                                                               |
| Grouping  | per queue (recognized queues plus unknown), and an overall total              |
| Empty     | 0                                                                             |
| Sources   | `approval_stage_tracking.queue_id`, `.status`, `.started_at`, `.completed_at` |
| Anchor    | `approval_stage_tracking.completed_at`                                        |

**Scope:** supplied approval stage records whose status is not `active`; an active stage has made no decision yet (subject: stage).

| #   | Condition                                                                                              | Exclusion code               |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 1   | The stage is not skipped or cancelled                                                                  | `skipped_or_cancelled_stage` |
| 2   | The stage status is one of `active`, `completed`, `skipped`, `cancelled` (`APPROVAL_STAGE_STATUSES`)   | `unrecognized_stage_status`  |
| 3   | A completed stage has a `completed_at`                                                                 | `stage_missing_completed_at` |
| 4   | `started_at` and `completed_at` are valid instants and `completed_at` is not earlier than `started_at` | `invalid_stage_timestamps`   |

**Flags:** `unknown_queue`.

**Rules:** rejections are included. A multi-stage request counts once in **each** queue that completed one of its stages. Completed stages of requests that are now approved, rejected or `completed` are included. The overall total includes unknown-queue stages and is the number of **stage decisions, not requests**.

**Limitations:** `stage_rows_directly_writable`, `stage_constraints_unenforced`, `stage_outcome_not_recorded`, `historical_stage_gaps`, `unbounded_reads`, `non_atomic_reads`, `role_scoped_visibility`.

## 5. Example calculations

All examples use one complete dataset and the calendar month **November 2026** (UTC: `2026-11-01T00:00:00Z` ≤ t < `2026-12-01T00:00:00Z`) unless stated otherwise. Data-quality counts cover the whole dataset (section 6).

| Request | created_at           | Status    | Stages                                                                                                         |
| ------- | -------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| A       | 2026-11-02T12:58:30Z | approved  | A1 `department_budget` 11-02T13:00Z → 11-04T13:00Z (48 h); A2 `dean_office` 11-04T13:00Z → 11-07T01:00Z (60 h) |
| B       | 2026-11-10T08:59:00Z | rejected  | B1 `department_budget` 11-10T09:00Z → 11-10T21:00Z (12 h, rejected)                                            |
| C       | 2026-11-12T10:00:00Z | approved  | C1 `research_admin` started 11-12T10:00:20Z, **still active** (status changed directly)                        |
| D       | 2026-10-30T11:59:00Z | approved  | D1 `department_budget` 10-30T12:00Z → 11-01T12:00Z (48 h)                                                      |
| E       | 2026-11-25T00:00:00Z | submitted | E1 `department_budget` started 11-25T00:00:10Z, active                                                         |
| F       | 2026-11-14T16:00:00Z | submitted | None (workflow failed)                                                                                         |
| P       | 2026-11-05T10:00:00Z | submitted | None (browser prototype)                                                                                       |

Prototype P is a request record with status `submitted`. It is inside the scope of Request Volume and of the workload `pending_without_stage` report, so it is counted under `prototype_request` there. It is outside the scope of the stage-based metrics and of the tracked terminal population, so it is neither included nor counted in those.

### 5.1 Request Volume

- November: A, B, C, E, F = **5**. D was created in October.
- Data quality: `prototype_request` = 1 (P).
- **Precedence:** a prototype record with an unparseable `created_at` fails conditions 1 and 2 but counts once, as `prototype_request`.
- **Boundary:** a request created at exactly `2026-12-01T00:00:00Z` counts in December.
- **Time zones:** a request created at `2026-11-01T03:30:00Z` (11:30 pm Eastern on October 31) is in the **November** calendar month (UTC), but inside the Eastern custom range `2026-10-01..2026-10-31`. Both follow existing F18 policy.

### 5.2 Active Queue Workload

**Snapshot at 2026-11-26T12:00:00Z.** Active stages in scope: C1 and E1.

| Queue               | Workload |
| ------------------- | -------- |
| `department_budget` | 1 (E)    |
| every other queue   | 0        |

- C1 fails condition 1 (request C is approved): `orphaned_active_stage` = 1.
- Pending requests with no stage records: F and P. P is excluded from that report (`prototype_request` = 1), so `pending_without_stage` = 1 (F).
- E has a stage, so it is never `pending_without_stage`.

**Second snapshot** with different data: R1 and R2 are active at `department_budget`, R3 at `dean_office`, R5 has **two** active `research_admin` rows, and R6 has `queue_id = 'procurement'`:

| Queue               | Workload |
| ------------------- | -------- |
| `department_budget` | 2        |
| `dean_office`       | 1        |
| `research_admin`    | 1        |
| unknown             | 1        |

Flags: `duplicate_active_stages` = 1 (R5), `unknown_queue` = 1 (R6).

### 5.3 Stage Processing Time (November)

Stages in scope: A1, A2, B1, C1, D1, E1. C1 fails condition 1 (`orphaned_active_stage` = 1, not in progress); E1 fails condition 2 (`in_progress_stage` = 1).

| Queue group         | Stage durations (h)       | Average  | Median                   |
| ------------------- | ------------------------- | -------- | ------------------------ |
| `department_budget` | 48 (A1), 12 (B1), 48 (D1) | **36.0** | **48.0**                 |
| `dean_office`       | 60 (A2)                   | **60.0** | **60.0**                 |
| Overall (pooled)    | 12, 48, 48, 60            | **42.0** | **48.0** ((48 + 48) / 2) |

- D1 started in October and completed in November, so it counts in **November**.
- B1 is a rejection and is included.
- The average of the two queue averages would be (36 + 60) / 2 = 48.0, which is **not** the pooled overall value.
- **Unknown queue:** adding a completed stage U1 with `queue_id = 'procurement'` (11-16T00:00Z → 11-17T00:00Z, 24 h) leaves the recognized queues unchanged, adds an unknown group of 24.0 h, and changes the pooled overall to (12 + 24 + 48 + 48 + 60) / 5 = **38.4 h** average and **48.0 h** median. `unknown_queue` = 1.
- **Completed request:** if a request G with status `completed` had a completed `dean_office` stage of 24 h in November, that stage would count in `dean_office` and the pooled overall. If G instead had an **active** stage, that stage would be `orphaned_active_stage`.

### 5.4 Request Turnaround Time (November)

Requests in scope (status approved, rejected or `completed`): A, B, C, D. E, F and P are pending and outside the population, so they are not counted.

| Request | Decision instant T(r) | TAT (h)                    | Identity check              |
| ------- | --------------------- | -------------------------- | --------------------------- |
| A       | 2026-11-07T01:00:00Z  | 108.025 (108 h 1 min 30 s) | 0.025 + 48 + 60 = 108.025 ✓ |
| B       | 2026-11-10T21:00:00Z  | 12.0167 (12 h 1 min)       | 0.0167 + 12 = 12.0167 ✓     |
| D       | 2026-11-01T12:00:00Z  | 48.0167 (48 h 1 min)       | 0.0167 + 48 = 48.0167 ✓     |

- **Average** = (108.025 + 12.0167 + 48.0167) / 3 = 168.0583 / 3 = **56.02 h**
- **Median** of 12.0167, 48.0167, 108.025 = **48.02 h**
- D was created in October but is decided in November, so it counts in November.
- C passes conditions 1–4 and fails condition 5: `terminal_request_with_active_stage` = 1.
- **Precedence:** a `completed` request with no stage records fails conditions 2 and 4 and counts once, as `completed_status`. An approved request with an invalid `created_at` and no stages counts once, as `invalid_created_at`.
- **Decision before creation:** an approved request whose `created_at` is 2026-11-20T00:00Z but whose final stage completed at 2026-11-19T00:00Z fails condition 7 and is excluded from both turnaround and approval rate under `decision_before_creation`.

### 5.5 Approval Rate (November)

- Same population as section 5.4. Approved: A, D. Rejected: B.
- **Approval Rate = 2 / 3 = 0.667 (66.7%)**
- C is excluded (`terminal_request_with_active_stage` = 1). E, F and P are pending and outside the population.
- **No decisions:** a period with no tracked terminal requests in a complete dataset returns **no-data**, not 0%.
- **Contrast with the dashboard:** for four requests with statuses Submitted, Under Review, Approved and Rejected, F19 gives 1 / 2 = 50%; the existing dashboard formula gives 1 / 4 = 25%.

### 5.6 Queue Throughput (November)

Stages in scope (not active): A1, A2, B1, D1. C1 and E1 are active and outside the scope.

| Queue               | Throughput            |
| ------------------- | --------------------- |
| `department_budget` | 3 (A1, B1, D1)        |
| `dean_office`       | 1 (A2)                |
| **Total**           | **4 stage decisions** |

- The total covers 3 distinct requests (A, B, D). A counts once in each of its two queues.
- **Unknown queue:** with U1 from section 5.3, the unknown group is 1 and the total becomes **5**; `unknown_queue` = 1.
- **Boundary:** a stage completed at exactly `2026-12-01T00:00:00Z` counts in December.

### 5.7 Load integrity

- The stage read returns 1,000 of 1,250 visible rows because of a row limit: `stage_read_incomplete`. Active Queue Workload, Stage Processing Time, Request Turnaround Time, Approval Rate and Queue Throughput return that error, not 0, no-data or data-quality counts. Request Volume needs only the request read and is still calculated.
- A stage whose `request_id` is not in the supplied request dataset (for example, the request was created between the two reads): `stage_request_not_loaded`. Every metric that requires both reads is blocked.
- The request read omits the `created_at` column: `request_field_missing`. Request Volume, Request Turnaround Time and Approval Rate are blocked. The rows are **not** counted as `invalid_created_at`, which applies only when `created_at` is present with a null or unparseable value.
- The workload stage read returns only active stages: `stage_read_incomplete`, because workload requires `all-statuses`. Otherwise a pending request whose stages are all completed or skipped would be misreported as `pending_without_stage`.

### 5.8 Amended request

This example uses its own dataset, separate from the table above, so the earlier November results are unchanged. Request H was created at 2026-11-03T09:00:00Z, approved at its first department stage, advanced to the dean's office, then amended. The amendment cancelled the active dean stage and restarted the chain as revision 2, whose single stage approved it.

| Stage | `workflow_revision` | `stage_order` | Queue               | started_at → completed_at   | Status    | Duration |
| ----- | ------------------- | ------------- | ------------------- | --------------------------- | --------- | -------- |
| H1    | 1                   | 1             | `department_budget` | 11-03T09:00Z → 11-04T09:00Z | completed | 24 h     |
| H2    | 1                   | 2             | `dean_office`       | 11-04T09:00Z → 11-05T09:00Z | cancelled | 24 h     |
| H3    | 2                   | 1             | `department_budget` | 11-05T09:00Z → 11-06T21:00Z | completed | 36 h     |

H's status is `approved`.

- **Decisive stage:** ordered by `(workflow_revision, stage_order)` the stages are (1, 1), (1, 2), (2, 1), so the decisive stage is **H3** and T(H) = 2026-11-06T21:00:00Z. Ordering by `stage_order` alone would pick the cancelled H2 and wrongly exclude H as `terminal_stage_invalid`.
- **Turnaround:** TAT(H) = 11-03T09:00Z → 11-06T21:00Z = **84 h**, measured from the original `created_at` and including the 48 h spent in revision 1. Identity check: 0 (intake gap) + 24 (H1) + 24 (H2) + 36 (H3) = 84 ✓. H2 is cancelled, so it can never be the decisive stage, but its 24 h of elapsed time falls between `created_at` and T(H), so it is part of the turnaround and must be included for the identity to hold.
- **Approval rate:** H counts once, as approved, in November.
- **Stage Processing Time:** H1 (24 h) and H3 (36 h) both count in `department_budget`; H2 is excluded as `skipped_or_cancelled_stage`.
- **Queue Throughput:** `department_budget` gains 2 stage decisions (H1, H3); `dean_office` gains none.
- **Active Queue Workload:** at 2026-11-06T00:00:00Z, H contributes 1 to `department_budget` (H3 active) and nothing to `dean_office`, because H2 is cancelled. After the decision it contributes nothing.

## 6. Data-quality codes

Data-quality codes describe records in a complete dataset. They are applied by these rules (`DATA_QUALITY_RULES`):

1. Data-quality codes apply only after the load-integrity precondition holds.
2. Records outside a metric's population scope are removed first and are not counted.
3. Each remaining record is checked against the population conditions in order. The first condition it fails gives its one primary exclusion code, and later conditions are not checked for that record.
4. Flags apply only to records that pass every condition, never remove them from the value, and a record can carry several flags. A request-level flag on a stage population (duplicate_active_stages) is counted once per request, from that request's stage records that pass every condition; those stage records stay included.
5. Counts are reported per metric for the whole supplied dataset, not per reporting period, because many excluded records have no valid anchor instant.

| Code                                 | Subject | Treatment           | Used by                                                                               |
| ------------------------------------ | ------- | ------------------- | ------------------------------------------------------------------------------------- |
| `prototype_request`                  | request | excluded            | `request_volume`, `active_queue_workload`, `request_turnaround_time`, `approval_rate` |
| `completed_status`                   | request | excluded            | `request_turnaround_time`, `approval_rate`                                            |
| `invalid_created_at`                 | request | excluded            | `request_volume`, `request_turnaround_time`, `approval_rate`                          |
| `untracked_terminal_request`         | request | excluded            | `request_turnaround_time`, `approval_rate`                                            |
| `terminal_request_with_active_stage` | request | excluded            | `request_turnaround_time`, `approval_rate`                                            |
| `terminal_stage_invalid`             | request | excluded            | `request_turnaround_time`, `approval_rate`                                            |
| `decision_before_creation`           | request | excluded            | `request_turnaround_time`, `approval_rate`                                            |
| `orphaned_active_stage`              | stage   | excluded            | `active_queue_workload`, `stage_processing_time`                                      |
| `in_progress_stage`                  | stage   | excluded            | `stage_processing_time`                                                               |
| `skipped_or_cancelled_stage`         | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `unrecognized_stage_status`          | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `stage_missing_completed_at`         | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `invalid_stage_timestamps`           | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `duplicate_active_stages`            | request | flagged             | `active_queue_workload`                                                               |
| `unknown_queue`                      | stage   | flagged             | `active_queue_workload`, `stage_processing_time`, `queue_throughput`                  |
| `pending_without_stage`              | request | reported separately | `active_queue_workload`                                                               |

The full descriptions are in `DATA_QUALITY_CHECKS`. The codes are stable identifiers: renaming, adding or removing one requires a version bump (section 9).

## 7. Data-quality and historical limitations

| Limitation                               | Resolved by    | Effect                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created_at_unverified_before_hardening` | not resolvable | Since migration `20261119120100_f19_5_4_1_security_hardening` the database assigns `created_at` on insert and rejects every change. Values stored before it may have been client-supplied or changed, unlogged, and cannot be verified. Affects Volume, Turnaround, Approval. |
| `stage_rows_directly_writable`           | F19.2          | Admin, reviewer and leadership can insert, update and delete stage rows, including timestamps.                                                                                                                                                                                |
| `status_update_bypasses_stage_closure`   | F19.2          | A direct status update leaves the active stage open, creating orphaned stages and decided requests without a trusted decision instant.                                                                                                                                        |
| `stage_constraints_unenforced`           | F19.2          | `queue_id` is free text; one active stage per request and one stage per queue per request are not database constraints.                                                                                                                                                       |
| `stage_outcome_not_recorded`             | F19.2          | Rejected stages are stored as `completed`; stage metrics cannot be split by outcome.                                                                                                                                                                                          |
| `historical_stage_gaps`                  | not resolvable | Requests created before F16 stage tracking was in place on a given database, and requests whose workflow failed, have no stages. No cutoff date is assumed (see below).                                                                                                       |
| `unbounded_reads`                        | F19.3          | Existing reads are not paginated and may be truncated; the stage loader in `requests-data.ts` reads only active stages and hides errors. Under section 3.3 these block calculation instead.                                                                                   |
| `non_atomic_reads`                       | by design      | Every required read is paginated (all metrics), and metrics that combine both tables also read them at different moments, so a loaded dataset is not a single database snapshot (see below).                                                                                  |
| `role_scoped_visibility`                 | by design      | Requesters see only their own rows (section 3.9).                                                                                                                                                                                                                             |

**Historical records.** The repository does not record when the F16 stage-tracking migration was applied to any database; its filename timestamp is when it was written, not when it was deployed. No cutoff date is therefore assumed. Past stage timings cannot be reconstructed, so no backfill is proposed. Requests without stage records are counted in Volume and reported under `untracked_terminal_request` or `pending_without_stage`; they never contribute estimated durations.

**Non-atomic reads.** Loaded data is not a single database snapshot, for two separate reasons:

- **Pagination (all eight metrics).** The shared F19.3 loader reads each required table in keyset pages ordered by `id`, over several API requests. Even a single-table read is therefore not atomic. This applies to Request Volume (`financial_requests` only) and Queue Throughput (`approval_stage_tracking` only), as well as to every metric that reads both tables.
- **Cross-table timing (six metrics).** Active Queue Workload, both Stage Processing Time variants, both Request Turnaround Time variants and Approval Rate require both `financial_requests` and `approval_stage_tracking`. The two tables are read by separate requests at different moments.

The loader validates what it can: pagination completeness (no duplicate or out-of-order IDs, no skipped pages, a cursor that always advances) and per-table counts (an exact count taken before and after paging that must equal the rows collected), plus `stage_request_not_loaded` across the two tables. A failed check is a load-integrity error (`*_read_incomplete` or `stage_request_not_loaded`), never partial data.

These checks detect some concurrent changes, but matching counts do **not** show that rows stayed unchanged during the read, and they cannot guarantee a consistent snapshot. They cannot detect:

- an insert and a delete that offset each other during a read;
- a row that changed after it was read (for a stage, after F19.2, only the transition from `active` to `completed`, `skipped` or `cancelled`; for a request, for example its status);
- changes made between the request read and the later stage read that leave both reads internally consistent.

Results are therefore described as of the load's read interval, not a single instant. Strict snapshot consistency would need both tables returned by one database statement, which is outside F19.3.

## 8. Dependencies

| Sub-feature                               | Depends on F19.1 for                                      | What it must deliver                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F19.2 – Capture Workflow Stage Events     | The limitations marked F19.2 (section 7)                  | Trusted `created_at`; restricted direct writes to stages and status; closing or cancelling stages on direct status changes; stage outcome; workflow-event write permissions. Migrations in `supabase/migrations/`.                                                                                                                                            |
| F19.3 – Capture Workload Data             | `SOURCE_FIELDS`, required reads, the load-integrity rule  | Paginated, error-reporting request and stage loaders that honour each metric's `stageReadCoverage` (every stage status for workload), select every required source field, validate pagination completeness and per-table counts, and report load-integrity errors by code, following the AGENTS.md read-error rules. Implemented as described in section 8.1. |
| F19.4 – Implement Efficiency Calculations | Every definition, population, precedence, anchor and code | Pure aggregation functions that read this catalog, block on load-integrity errors, apply conditions in order, use the F18 half-open period test (`isWithinPeriod`, the test `filterByPeriod` applies), and return values with data-quality counts by code. Implemented as described in section 8.3.                                                           |
| F19.5 – Validate and Document Analytics   | Section 5 examples and the turnaround identity            | Tests reproducing section 5, SQL verification for F19.2 changes, and an update to the F19 row of `docs/Lab5_Requirements_Traceability_Matrix.md`.                                                                                                                                                                                                             |

Metrics that can be calculated before F19.2 lands: all six, once F19.3 provides complete reads. Their exclusion counts show how incomplete the data is until F19.2 closes the integrity gaps.

### 8.1 F19.3 data loading (implemented)

F19.3 adds no table, migration, view or workload snapshot store. It reads the two existing source tables.

**Reads.** `loadEfficiencyDataset({ userId, signal, pageSize = 500, maxAttempts = 2 })` in `efficiency-data-loader.ts`:

1. reads `financial_requests` in full through the shared `supabase` client, selecting `EFFICIENCY_REQUEST_COLUMNS` (exactly `SOURCE_FIELDS.financial_requests`: `id`, `status`, `created_at`);
2. then reads `approval_stage_tracking` in full through `approvalStageClient`, the typed view of the same client and session, selecting `EFFICIENCY_STAGE_COLUMNS` (the `id` pagination key plus `SOURCE_FIELDS.approval_stage_tracking`, including `workflow_revision`);
3. passes both table results to `checkDatasetIntegrity`.

- There is **no status filter** and no user filter. Every status and every workflow revision of every row that RLS shows the session is loaded, which is the `all-statuses` stage read coverage (section 3.3). Visibility stays role-scoped (section 3.9).
- No person-level or actor column is selected, and nothing is written.
- The select lists are built from the column constants, so they cannot drift from `SOURCE_FIELDS`.

**Per-table validation** (`readAllPages` in `efficiency-data.ts`). Each table is read as:

- an exact, head-only count;
- keyset pages: `id > cursor`, ordered by `id` ascending, limited to `pageSize`, until an **empty** page (a short page does not end the read, so a server row cap cannot truncate it);
- a second exact count.

A table read is complete only when every request succeeded, every row has every selected column (a present `null` is allowed and left to the data-quality rules), keys are unique and strictly increasing, no page exceeds `pageSize`, the read ends within the page limit, and both counts equal the rows collected. Otherwise:

| Outcome of one table read                                                                                                                                | Load-integrity code                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A query returned an error or threw                                                                                                                       | `*_read_failed`, with an access or unavailable `issue` |
| A count is unavailable or the counts disagree; a page overflows or has no data; a key is invalid, repeated or out of order; or the page limit is reached | `*_read_incomplete`                                    |
| A returned row lacks a selected column                                                                                                                   | `*_field_missing`                                      |
| A stage's request is not in the request read                                                                                                             | `stage_request_not_loaded`                             |

The `issue` uses the shared `classifyRequestReadError`, so a permission failure stays distinct from an outage and from an empty result. A table whose read was not complete never contributes rows, and a query error is never replaced by an empty array.

**Result.** Every result carries the `userId` it was loaded for and the number of `attempts`:

- `complete`: `{ requests, stages, consistency: "per-table-validated", reads }`, where `reads` gives each table's read window. It is **not** a database snapshot (`non_atomic_reads`, section 7).
- `blocked`: the codes in `LOAD_INTEGRITY_ERROR_CODES` order, the `issue` of the first failed read, and `completeTables`, which holds each table whose own read was complete. F19.4 blocks a metric only on the codes in its `loadIntegrityErrors`, so Request Volume can still use a complete request read when the stage read failed, and Queue Throughput can still use a complete stage read when the request read failed (section 5.7).
- `cancelled`: no rows.

**Retry policy.** The whole load is repeated, immediately, up to `maxAttempts` in total (default 2), only when **every** error is race-related:

- `stage_request_not_loaded`, typically a request created between the two reads; or
- `*_read_incomplete` whose table read ended in a count mismatch.

Ids are immutable primary keys read in key order, so a concurrent write shows up only as a count mismatch. Nothing else is retried: failed reads (access or outage), missing fields, the other incomplete reasons (count unavailable, page overflow, invalid, duplicate or out-of-order keys, page limit, missing page data), any mix of race and non-race errors, and cancellation. When the attempts run out, the final attempt's result is returned. A retry reduces race-related blocks; it cannot remove them, and it does not make the reads atomic.

**Identity and cancellation.** `userId` comes from the existing auth context. It is not sent to the database, where RLS uses the session, and it is returned so the caller can discard a load for a user who is no longer signed in. The `AbortSignal` is passed to every query and checked between them. Once it is aborted, no further query or retry starts and the result is `cancelled`, never a dataset. Invalid options throw `RangeError` before any query.

**Concurrent changes.** The checks above detect some concurrent changes, but they do not show that rows stayed unchanged and cannot guarantee a consistent snapshot. Their limits are listed under non-atomic reads in section 7.

**Prototype data.** The loader reads only database rows. Prototype requests stored in the browser are never loaded or merged here. A later analytics layer may merge them, scoped to the signed-in owner, where they are counted under `prototype_request` (section 3.6).

**Not part of F19.3:** metric aggregation (F19.4) and any route, dashboard or UI change.

Validate the loader with:

```sh
npx vitest run src/lib/efficiency-data.test.ts src/lib/efficiency-data-loader.test.ts
```

### 8.2 F19.2 decision status guard (implemented)

Before this follow-up, a recorded decision could be undone in two ways: `f19_amend_request_workflow` accepted requests in any status and reset them to `submitted`, and the `financial_requests` update policy let admin and reviewer roles change `status` directly. Either path removed a decided request from the tracked terminal population of an already closed period, with no data-quality code to show it, and the original outcome is not kept in any trusted source (a rejected stage is stored as `completed`, `stage_outcome_not_recorded`).

`supabase/migrations/20261119072711_f19_2_decision_status_guard.sql` adds two layers without editing the F19.2 migration:

- **Amendment eligibility.** `f19_amend_request_workflow` refuses requests that are not `submitted` or `under_review`. The check runs after the row lock and authorization check and before any validation or write; the rest of the function, its grants and the pending-request amendment flow are unchanged.
- **Status guard.** The `zz_f19_guard_request_status` trigger (`BEFORE INSERT OR UPDATE`, fires after every other BEFORE trigger) enforces:

| Rule | Applies to                                          | Effect                                                                                                              |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1   | Every caller                                        | `approved`, `rejected` and `completed` never change, including `approved → completed`                               |
| R2   | API roles (`anon`, `authenticated`, `service_role`) | No status change; inserts must be `submitted`                                                                       |
| R3   | The table owner                                     | Only `submitted → under_review`, `under_review → submitted`, and `submitted`/`under_review` → `approved`/`rejected` |
| R4   | The table owner, moving to `approved` or `rejected` | No active stage, and the highest-`stage_order` stage of the current `workflow_revision` is `completed`              |

**Trust.** The trigger function is `SECURITY INVOKER`, so `current_user` is the role running the statement: the API role for a direct write, and the function owner inside the `SECURITY DEFINER` workflow functions (`f16_record_approval_decision`, `f19_amend_request_workflow`). A write is trusted only when `current_user` is the table owner, read from `pg_class` at run time. Custom settings such as `app.f19_trusted_workflow_write` are not trusted, because any role can set them.

**Effect on the metrics.** Every new decision is made by `f16_record_approval_decision`, is backed by a completed final stage (so condition 6 can always derive T(r)), and cannot later leave the tracked terminal population. This closes the direct-update path described by `status_update_bypasses_stage_closure`. The catalog is unchanged and no version bump is needed. Requests reopened before the guard was applied are not repaired or reconstructed; identifying them is an F19.5 verification task.

Validate the guard against the local stack:

```sh
npx vitest run src/lib/workflow/decision-status-guard-migration.test.ts
docker exec -i <local-db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X < verification/f19_2_status_guard.sql
bash verification/f19_2_status_guard_concurrency.sh <local-db-container>
```

### 8.3 F19.4 metric calculations (implemented)

F19.4 calculates every catalog metric from an F19.3 load result. The calculations are pure functions in the modules listed in section 2; they read the catalog and never redefine it. Formulas, populations, condition order, flags and separate reports are exactly those of sections 3 to 6.

**Entry point.** `calculateEfficiencyMetrics(input)` in `efficiency-analytics.ts`:

```ts
calculateEfficiencyMetrics({
  load,               // DatasetIntegrityResult (or the loader's EfficiencyLoadResult)
  period,             // F18 PeriodBounds for the period-assigned metrics
  prototypeRequests,  // optional; must already be scoped to the signed-in owner
}): {
  catalogVersion,     // EFFICIENCY_METRICS_VERSION
  period,             // the period given to the period-assigned metrics
  metrics,            // one result per metric id, in EFFICIENCY_METRIC_IDS order
}
```

It calls each metric's own calculator with the same load and returns that calculator's result unchanged, so every metric keeps its own result type. It does no calculation of its own.

| Metric ID                                                           | Calculator                                 |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `request_volume`                                                    | `calculateRequestVolume`                   |
| `active_queue_workload`                                             | `calculateActiveQueueWorkload`             |
| `stage_processing_time_average`, `stage_processing_time_median`     | `calculateStageProcessingTime(metricId)`   |
| `request_turnaround_time_average`, `request_turnaround_time_median` | `calculateRequestTurnaroundTime(metricId)` |
| `approval_rate`                                                     | `calculateApprovalRate`                    |
| `queue_throughput`                                                  | `calculateQueueThroughput`                 |

**Result statuses.** Every metric result is one of:

- `calculated`: the value, with `metricId`, `catalogVersion`, the period (or, for workload, the snapshot's read windows), the records counted and the population with its exclusion and flag counts.
- `blocked`: a load-integrity error that applies to this metric, with its codes, the incomplete required tables, the read `issue` (access or unavailable) and every error on the load. It has no value, no zero, no no-data and no data-quality counts (section 3.3).
- `cancelled`: the load was cancelled. Nothing is calculated.

Within a calculated result, an empty population gives the catalog's `emptyResult`: the number 0 for Request Volume, Queue Throughput and every recognized queue of Active Queue Workload; no-data (`{ kind: "no-data" }`, never 0) for Stage Processing Time, Request Turnaround Time and Approval Rate (when A + R = 0). A value is `{ kind: "value", value }`, in hours or as a fraction from 0 to 1 for Approval Rate.

**Independent load gating.** There is no global gate. Each calculator applies `gateMetricLoad` with its own catalog `requiredReads` and `loadIntegrityErrors`, so one failed read blocks only the metrics that need it:

| Metric                  | Reads it needs      | Calculated despite                                       |
| ----------------------- | ------------------- | -------------------------------------------------------- |
| Request Volume          | requests only       | any stage read error and `stage_request_not_loaded`      |
| Queue Throughput        | stages only         | any request read error and `stage_request_not_loaded`    |
| Stage Processing Time   | requests and stages | nothing: every read error and `stage_request_not_loaded` |
| Request Turnaround Time | requests and stages | nothing: every read error and `stage_request_not_loaded` |
| Approval Rate           | requests and stages | nothing: every read error and `stage_request_not_loaded` |
| Active Queue Workload   | requests and stages | nothing: every read error and `stage_request_not_loaded` |

**Periods and the workload snapshot.** The seven period-assigned metrics receive the same `period` and test their catalog anchor with the F18 half-open rule (`startUtc <= instant < endExclusiveUtc`): `created_at` for Request Volume, the stage's `completed_at` for Stage Processing Time and Queue Throughput, and the decisive stage's `completed_at` (T(r)) for Request Turnaround Time and Approval Rate. The period filter runs after classification, so data-quality counts describe the whole supplied dataset in every period (rule 5). Active Queue Workload is a snapshot: it never receives the period, uses no timestamp and reports each table's read window instead.

**Active Queue Workload output.** One distinct-request count per recognized queue, always present and 0 when empty, plus the unknown group when it has workload. There is no overall value: the catalog groups this metric by queue only, and summing the queues would count a request active in two queues twice. `pending_without_stage` is reported separately and never changes the workload.

**Prototype requests.** The caller must scope `prototypeRequests` to the signed-in owner (AGENTS.md); F19.4 cannot check ownership and never loads or infers prototypes. They are passed to the metrics whose request populations can count them (Request Volume, Request Turnaround Time, Approval Rate and the workload `pending_without_stage` report), have no stages, and are only ever counted under `prototype_request`.

**Errors.** The calculators throw, rather than return a value, for programming errors: a `RangeError` for invalid period bounds (even when the load is blocked or cancelled), and an `Error` when ids repeat, which a validated F19.3 load cannot contain.

**Not resolved by F19.4.** The limitations in section 7 still apply to every result. F19.4 reports their effects as data-quality counts; it does not repair data, reconstruct past stages or make the reads atomic.

Validate the calculations with:

```sh
npx vitest run src/lib/efficiency-stats.test.ts src/lib/efficiency-population.test.ts src/lib/efficiency-population-classification.test.ts src/lib/efficiency-request-volume.test.ts src/lib/efficiency-stage-processing-time.test.ts src/lib/efficiency-queue-throughput.test.ts src/lib/efficiency-decision-metrics.test.ts src/lib/efficiency-active-queue-workload.test.ts src/lib/efficiency-analytics.test.ts
```

### 8.4 F19.5.4 security hardening (implemented)

Two migrations close integrity gaps found by the F19.5.4 audit. Design, privilege matrix and verification: `docs/F19_Security_Hardening.md`.

- `20261119120100_f19_5_4_1_security_hardening.sql`: the database assigns `financial_requests.created_at` on insert and rejects every change, for every role and status; API-role privileges RLS cannot govern (TRUNCATE, TRIGGER, REFERENCES, MAINTAIN) and unused direct writes are revoked on the F19 tables.
- `20261119130000_f19_5_4_2_event_provenance.sql`: clients cannot write database-generated `workflow_events` types or sources, and client events take their actor and time from the database; future tables no longer grant DELETE to `authenticated` by default.

**Effect on the metrics.** `created_at` written after the first migration is trusted, so `created_at_client_writable` is replaced by `created_at_unverified_before_hardening`, which covers only values stored before it (catalog `2026-11-19.2`). Formulas, populations and codes are unchanged. `workflow_events` is still not a source.

## 9. Versioning

- `EFFICIENCY_METRICS_VERSION` uses the `RULES_VERSION` format `YYYY-MM-DD.N`, starting at `2026-11-18.1`.
- **Bump it by hand** whenever any of these changes (`VERSION_BUMP_TRIGGERS`):
  - a metric definition or formula
  - a statistic, unit, grouping or empty result
  - a population scope, condition or condition order
  - a flag or separate report
  - a source field or required read
  - a period anchor
  - a data-quality code, subject or treatment
  - a load-integrity error or the load-integrity precondition
  - a known limitation
- The version identifies the catalog as committed. Changes made before the first commit are part of `2026-11-18.1`; every change after it requires a bump.
- F19.4 results are only comparable within one version.

| Version        | Change                                                                                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-11-18.1` | Initial F19.1 catalog.                                                                                                                                                                                                                                                                                            |
| `2026-11-18.2` | F19.3 Checkpoint 0: `approval_stage_tracking.workflow_revision` added to `SOURCE_FIELDS` and the decision metrics; decisive stage is the highest `(workflow_revision, stage_order)`; `non_atomic_reads` limitation added.                                                                                         |
| `2026-11-19.1` | F19.4.0: `unrecognized_stage_status` code and `APPROVAL_STAGE_STATUSES` added; the new condition follows `skipped_or_cancelled_stage` in Stage Processing Time and Queue Throughput; `terminal_stage_invalid` and condition 6 now cover integer ordering, ties at the highest pair, and null or non-integer keys. |
| `2026-11-19.2` | F19.5.4.2: `created_at_client_writable` replaced by `created_at_unverified_before_hardening` (not resolvable), because migration `20261119120100_f19_5_4_1_security_hardening` makes `created_at` database-assigned and immutable; only values stored before it remain unverifiable.                              |

- No automated check enforces the bump; reviewers must confirm it.
- Update this document in the same change.

## 10. Validating the catalog

```sh
npx vitest run src/lib/efficiency-metrics.test.ts
npx vitest run
npx tsc --noEmit
```

The tests check:

- identifiers, families, versions, deep freezing and non-empty text;
- each metric's statistic, unit, grouping, empty result, period anchor, required reads, stage read coverage and load-integrity errors;
- that workload, and every metric that detects active stages or the absence of stages, requires `all-statuses` stage reads;
- that a missing required field is a load-integrity error, distinct from an invalid or null value;
- each metric's exact population scope subject, ordered exclusion codes, flags, separate reports and limitations;
- precedence: one primary exclusion code per record, with worked cases from section 5;
- that load-integrity errors block calculation and never overlap data-quality codes;
- unknown-queue, completed-status and orphaned-stage behaviour;
- the complete tracked terminal population, shared by turnaround and approval rate;
- that sources come only from `SOURCE_FIELDS`, every allowlisted field is used, and `workflow_events` and `updated_at` are never sources;
- the schema against the whole migration history (`supabase/migrations` and `drizzle/migrations`, including later `ALTER TABLE` and `ALTER TYPE` statements), with parser tests for the replay itself;
- that pending, terminal and excluded statuses exactly cover the `request_status` enum (also checked at compile time against the generated types);
- that this document agrees with the catalog: the section 6 table, every condition table in section 4, the flag lines, the load-integrity codes, the stage read coverage table in section 3.3, the rules in section 6 and the version-bump list in section 9;
- workflow revisions: the decisive stage is named by the `(workflow_revision, stage_order)` pair everywhere and never by `stage_order` alone, the decision metrics read both fields, and turnaround keeps the original `created_at` basis, including pre-amendment time (section 3.10, section 5.8);
- that `non_atomic_reads` applies to every metric, separates pagination (all metrics) from cross-table timing (metrics that read both tables), and states that matching counts do not show stable rows or a consistent snapshot;
- that the decisive stage must be completed, while cancelled stages still contribute elapsed time to turnaround;
- that the decisive stage rule states integer ordering, ties and invalid keys, and that `unrecognized_stage_status` follows `skipped_or_cancelled_stage` in both stage populations, with `APPROVAL_STAGE_STATUSES` matching the database `CHECK` constraint;
- that the section 7 table and the section 3.4 source list match the catalog;
- module boundaries: the catalog imports only `deep-freeze.ts`, F18 modules do not import it, and it exports no functions.
