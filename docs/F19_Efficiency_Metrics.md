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

| File                                 | Role                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/lib/efficiency-metrics.ts`      | Metric catalog, load-integrity errors, data-quality codes, known limitations, version       |
| `src/lib/efficiency-metrics.test.ts` | Catalog definition tests, documentation agreement, migration-history schema checks, imports |
| `docs/F19_Efficiency_Metrics.md`     | This specification                                                                          |

Dependency direction (arrows point to the module being imported):

```
efficiency-metrics.ts ──▶ deep-freeze.ts   (no imports)
```

- The catalog imports only `deep-freeze.ts`. It does not import React, Supabase clients, routes or F18 modules.
- F18 modules (`time-zones.ts`, `reporting-periods.ts`, `reporting-period-config.ts`, `date-range-filter.ts`) and `deep-freeze.ts` must not import the catalog. A test checks both directions.
- The catalog exports no functions. A test checks this, so calculation logic cannot be added here by accident.

Catalog exports:

| Export                                                                               | Content                                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `EFFICIENCY_METRICS_VERSION`, `VERSION_BUMP_TRIGGERS`                                | Catalog version and the changes that require a bump (section 9)         |
| `EFFICIENCY_METRIC_FAMILIES`                                                         | The six approved metrics                                                |
| `EFFICIENCY_METRIC_IDS`                                                              | Eight stable identifiers (the average and median variants are separate) |
| `EFFICIENCY_METRICS`                                                                 | Definitions keyed by identifier                                         |
| `SOURCE_FIELDS`                                                                      | The only database columns a metric may reference; each one is used      |
| `TERMINAL_REQUEST_STATUSES`, `PENDING_REQUEST_STATUSES`, `EXCLUDED_REQUEST_STATUSES` | `approved, rejected` / `submitted, under_review` / `completed`          |
| `UNKNOWN_QUEUE_GROUP`                                                                | The group for unrecognized queue IDs (`unknown`)                        |
| `LOAD_INTEGRITY_PRECONDITION`, `LOAD_INTEGRITY_ERROR_CODES`, `LOAD_INTEGRITY_ERRORS` | Load-integrity rule and the errors that block calculation (section 3.3) |
| `STAGE_READ_COVERAGE`                                                                | Which stage records each stage read must return (section 3.3)           |
| `TRACKED_TERMINAL_POPULATION`                                                        | The shared turnaround and approval-rate population (section 4.4)        |
| `STATISTIC_DEFINITIONS`                                                              | Average and median definitions                                          |
| `DATA_QUALITY_RULES`, `DATA_QUALITY_CODES`, `DATA_QUALITY_CHECKS`                    | Precedence rules and record-level codes (section 6)                     |
| `KNOWN_LIMITATION_IDS`, `KNOWN_LIMITATIONS`                                          | Known data limitations and what resolves them (section 7)               |

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
| Request Turnaround Time | Decision instant: `completed_at` of the request's highest-numbered stage |
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

- Only `financial_requests` (`id`, `status`, `created_at`) and `approval_stage_tracking` (`request_id`, `stage_order`, `queue_id`, `status`, `started_at`, `completed_at`) are used.
- `financial_requests.updated_at` is never used. Triggers update it for changes unrelated to the workflow, such as metadata and attachment sync.
- `workflow_events` is **not** a source, including for outcomes, while requesters and reviewers can insert arbitrary rows into it (F19.2).

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

**Limitations:** `created_at_client_writable`, `unbounded_reads`, `role_scoped_visibility`.

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
| Anchor    | None: a snapshot of the current moment                                                           |

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

**Limitations:** `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `stage_constraints_unenforced`, `historical_stage_gaps`, `unbounded_reads`, `role_scoped_visibility`.

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
| 4   | A completed stage has a `completed_at`                                                                    | `stage_missing_completed_at` |
| 5   | `started_at` and `completed_at` are valid instants and `completed_at` is not earlier than `started_at`    | `invalid_stage_timestamps`   |

Condition 1 comes before condition 2, so an orphaned stage is never counted as an ordinary in-progress stage.

**Flags:** `unknown_queue`.

**Rules:** rejected stages are included, since a rejection is a decision the queue spent time on. Completed stages of requests that are now approved, rejected or `completed` are included; request status affects only active stages. Stages are not split by outcome, because the outcome is not recorded on the stage row (`stage_outcome_not_recorded`).

**Limitations:** `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `stage_constraints_unenforced`, `stage_outcome_not_recorded`, `historical_stage_gaps`, `unbounded_reads`, `role_scoped_visibility`.

The existing `queuePerformance` block in `src/routes/sla.tsx` is similar but is not this metric: it is untested and falls back to `started_at` when `completed_at` is missing. F19 does not copy that fallback.

### 4.4 Request Turnaround Time — `request_turnaround_time_average`, `request_turnaround_time_median`

**Definition:** the calendar time from when a request was received to its final approval or rejection.

**Tracked terminal population** (`TRACKED_TERMINAL_POPULATION`, shared with Approval Rate). Scope: requests whose status is `approved`, `rejected` or `completed`; pending requests are outside the population and are not counted (subject: request). A **tracked terminal request** is one that meets every condition:

| #   | Condition                                                                                                   | Exclusion code                       |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | The request is a real database request, not a browser prototype                                             | `prototype_request`                  |
| 2   | The status is `approved` or `rejected`; `completed` is never treated as approved                            | `completed_status`                   |
| 3   | `created_at` is a valid instant                                                                             | `invalid_created_at`                 |
| 4   | The request has at least one approval stage record                                                          | `untracked_terminal_request`         |
| 5   | None of the request's stages is active                                                                      | `terminal_request_with_active_stage` |
| 6   | The highest-numbered stage has status `completed` and a valid `completed_at`, the decision instant **T(r)** | `terminal_stage_invalid`             |
| 7   | T(r) is not earlier than `created_at`                                                                       | `decision_before_creation`           |

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

| Property  | Value                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Statistic | average; median                                                                                                                     |
| Unit      | hours                                                                                                                               |
| Grouping  | overall                                                                                                                             |
| Empty     | no-data                                                                                                                             |
| Sources   | `financial_requests.id`, `.status`, `.created_at`; `approval_stage_tracking.request_id`, `.stage_order`, `.status`, `.completed_at` |
| Anchor    | Decision instant `T(r)`                                                                                                             |

**Flags:** none.

**Limitations:** `created_at_client_writable`, `stage_rows_directly_writable`, `status_update_bypasses_stage_closure`, `historical_stage_gaps`, `unbounded_reads`, `role_scoped_visibility`.

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

| #   | Condition                                                                                                   | Exclusion code                       |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | The request is a real database request, not a browser prototype                                             | `prototype_request`                  |
| 2   | The status is `approved` or `rejected`; `completed` is never treated as approved                            | `completed_status`                   |
| 3   | `created_at` is a valid instant                                                                             | `invalid_created_at`                 |
| 4   | The request has at least one approval stage record                                                          | `untracked_terminal_request`         |
| 5   | None of the request's stages is active                                                                      | `terminal_request_with_active_stage` |
| 6   | The highest-numbered stage has status `completed` and a valid `completed_at`, the decision instant **T(r)** | `terminal_stage_invalid`             |
| 7   | T(r) is not earlier than `created_at`                                                                       | `decision_before_creation`           |

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
| 2   | A completed stage has a `completed_at`                                                                 | `stage_missing_completed_at` |
| 3   | `started_at` and `completed_at` are valid instants and `completed_at` is not earlier than `started_at` | `invalid_stage_timestamps`   |

**Flags:** `unknown_queue`.

**Rules:** rejections are included. A multi-stage request counts once in **each** queue that completed one of its stages. Completed stages of requests that are now approved, rejected or `completed` are included. The overall total includes unknown-queue stages and is the number of **stage decisions, not requests**.

**Limitations:** `stage_rows_directly_writable`, `stage_constraints_unenforced`, `stage_outcome_not_recorded`, `historical_stage_gaps`, `unbounded_reads`, `role_scoped_visibility`.

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
| `stage_missing_completed_at`         | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `invalid_stage_timestamps`           | stage   | excluded            | `stage_processing_time`, `queue_throughput`                                           |
| `duplicate_active_stages`            | request | flagged             | `active_queue_workload`                                                               |
| `unknown_queue`                      | stage   | flagged             | `active_queue_workload`, `stage_processing_time`, `queue_throughput`                  |
| `pending_without_stage`              | request | reported separately | `active_queue_workload`                                                               |

The full descriptions are in `DATA_QUALITY_CHECKS`. The codes are stable identifiers: renaming, adding or removing one requires a version bump (section 9).

## 7. Data-quality and historical limitations

| Limitation                             | Resolved by    | Effect                                                                                                                                                                                      |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created_at_client_writable`           | F19.2          | A client can supply `created_at` on insert, and the owner can change it while the request is submitted. F5 does not log it. Affects Volume, Turnaround, Approval.                           |
| `stage_rows_directly_writable`         | F19.2          | Admin, reviewer and leadership can insert, update and delete stage rows, including timestamps.                                                                                              |
| `status_update_bypasses_stage_closure` | F19.2          | A direct status update leaves the active stage open, creating orphaned stages and decided requests without a trusted decision instant.                                                      |
| `stage_constraints_unenforced`         | F19.2          | `queue_id` is free text; one active stage per request and one stage per queue per request are not database constraints.                                                                     |
| `stage_outcome_not_recorded`           | F19.2          | Rejected stages are stored as `completed`; stage metrics cannot be split by outcome.                                                                                                        |
| `historical_stage_gaps`                | not resolvable | Requests created before F16 stage tracking was in place on a given database, and requests whose workflow failed, have no stages. No cutoff date is assumed (see below).                     |
| `unbounded_reads`                      | F19.3          | Existing reads are not paginated and may be truncated; the stage loader in `requests-data.ts` reads only active stages and hides errors. Under section 3.3 these block calculation instead. |
| `role_scoped_visibility`               | by design      | Requesters see only their own rows (section 3.9).                                                                                                                                           |

**Historical records.** The repository does not record when the F16 stage-tracking migration was applied to any database; its filename timestamp is when it was written, not when it was deployed. No cutoff date is therefore assumed. Past stage timings cannot be reconstructed, so no backfill is proposed. Requests without stage records are counted in Volume and reported under `untracked_terminal_request` or `pending_without_stage`; they never contribute estimated durations.

## 8. Dependencies

| Sub-feature                               | Depends on F19.1 for                                      | What it must deliver                                                                                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F19.2 – Capture Workflow Stage Events     | The limitations marked F19.2 (section 7)                  | Trusted `created_at`; restricted direct writes to stages and status; closing or cancelling stages on direct status changes; stage outcome; workflow-event write permissions. Migrations in `supabase/migrations/`.                                                                |
| F19.3 – Capture Workload Data             | `SOURCE_FIELDS`, required reads, the load-integrity rule  | Paginated, error-reporting request and stage loaders that honour each metric's `stageReadCoverage` (every stage status for workload), select every required source field, prove completeness, and report load-integrity errors by code, following the AGENTS.md read-error rules. |
| F19.4 – Implement Efficiency Calculations | Every definition, population, precedence, anchor and code | Pure aggregation functions that read this catalog, block on load-integrity errors, apply conditions in order, use `filterByPeriod` for periods, and return values with data-quality counts by code.                                                                               |
| F19.5 – Validate and Document Analytics   | Section 5 examples and the turnaround identity            | Tests reproducing section 5, SQL verification for F19.2 changes, and an update to the F19 row of `docs/Lab5_Requirements_Traceability_Matrix.md`.                                                                                                                                 |

Metrics that can be calculated before F19.2 lands: all six, once F19.3 provides complete reads. Their exclusion counts show how incomplete the data is until F19.2 closes the integrity gaps.

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
- module boundaries: the catalog imports only `deep-freeze.ts`, F18 modules do not import it, and it exports no functions.
