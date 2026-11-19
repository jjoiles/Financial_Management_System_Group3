import { deepFreeze } from "@/lib/deep-freeze";

/**
 * F19.1: Efficiency metric catalog.
 *
 * Declarative definitions of the F19 efficiency and process metrics: what
 * each one measures, its formula, source fields, required reads, population
 * and exclusion precedence, flags, reporting-period anchor and known
 * limitations. Pure, browser-safe data with no I/O.
 *
 * This module describes metrics; it never calculates them.
 * - Aggregation functions: F19.4.
 * - Data loaders and workload capture: F19.3.
 * - Database integrity, permissions and schema changes: F19.2.
 * - Validation evidence and documentation updates: F19.5.
 * See docs/F19_Efficiency_Metrics.md.
 *
 * Conventions that apply to every metric
 * - Load integrity comes first (LOAD_INTEGRITY_PRECONDITION): a failed or
 *   partial read, or a read missing a required field, is an error, never a
 *   zero, a no-data result or a data-quality count.
 * - Durations are calendar hours: elapsed milliseconds / 3,600,000. There is
 *   no business-hours or holiday adjustment.
 * - Full precision is kept internally; values are rounded only for display.
 * - Reporting periods are F18 PeriodBounds and are half-open:
 *   startUtc <= instant < endExclusiveUtc. Fiscal and calendar-month periods
 *   keep their UTC boundaries; academic periods and custom ranges keep
 *   America/New_York. This module does not choose zones or build periods.
 * - Request creation timing is financial_requests.created_at, never
 *   updated_at (which triggers rewrite on unrelated changes).
 * - Approved and rejected are the only terminal outcomes. A `completed`
 *   request is excluded from decision metrics and counted under the
 *   completed_status data-quality exclusion, never treated as approved.
 * - workflow_events is not a source while its write permissions are
 *   unresolved (F19.2).
 * - Workload is measured per approval queue. There is no person-level
 *   workload or reviewer assignment.
 * - Prototype (browser-only) and mock records are never real data.
 * - Data-quality exclusions follow DATA_QUALITY_RULES: one primary code per
 *   excluded record, nothing dropped silently.
 *
 * Dependency direction: this module imports only deep-freeze.ts, which has no
 * imports. It must not import React, Supabase clients, routes or F18 modules,
 * and F18 modules must not import it. A test checks both.
 */

/**
 * Catalog version, in the RULES_VERSION format YYYY-MM-DD.N. Bump it by hand
 * whenever any change listed in VERSION_BUMP_TRIGGERS is made, because F19.4
 * results are only comparable within one version.
 *
 * The version identifies the catalog as committed. Changes made before the
 * first commit are part of `2026-11-18.1`; every change after it requires a
 * bump.
 */
export const EFFICIENCY_METRICS_VERSION = "2026-11-18.1";

/** Changes that require a version bump. docs/F19_Efficiency_Metrics.md section 9 lists the same items. */
export const VERSION_BUMP_TRIGGERS = Object.freeze([
  "a metric definition or formula",
  "a statistic, unit, grouping or empty result",
  "a population scope, condition or condition order",
  "a flag or separate report",
  "a source field or required read",
  "a period anchor",
  "a data-quality code, subject or treatment",
  "a load-integrity error or the load-integrity precondition",
  "a known limitation",
] as const);

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** The six approved F19 metrics. Stage processing and turnaround have two variants each. */
export const EFFICIENCY_METRIC_FAMILIES = Object.freeze([
  "request_volume",
  "active_queue_workload",
  "stage_processing_time",
  "request_turnaround_time",
  "approval_rate",
  "queue_throughput",
] as const);
export type EfficiencyMetricFamily = (typeof EFFICIENCY_METRIC_FAMILIES)[number];

/** Stable metric identifiers, in catalog order. */
export const EFFICIENCY_METRIC_IDS = Object.freeze([
  "request_volume",
  "active_queue_workload",
  "stage_processing_time_average",
  "stage_processing_time_median",
  "request_turnaround_time_average",
  "request_turnaround_time_median",
  "approval_rate",
  "queue_throughput",
] as const);
export type EfficiencyMetricId = (typeof EFFICIENCY_METRIC_IDS)[number];

// ---------------------------------------------------------------------------
// Source fields
// ---------------------------------------------------------------------------

/**
 * Every database column a metric may read. Metric sources and period anchors
 * can only name these, so a typo fails type checking. Every listed column is
 * used by at least one metric, and a test checks each one against the
 * migration history.
 *
 * Deliberately absent: financial_requests.updated_at (not workflow timing),
 * and the whole workflow_events table (writable by requesters and reviewers
 * until F19.2).
 */
export const SOURCE_FIELDS = Object.freeze({
  financial_requests: Object.freeze(["id", "status", "created_at"] as const),
  approval_stage_tracking: Object.freeze([
    "request_id",
    "stage_order",
    "queue_id",
    "status",
    "started_at",
    "completed_at",
  ] as const),
});
export type SourceTable = keyof typeof SOURCE_FIELDS;
export type SourceField<T extends SourceTable> = (typeof SOURCE_FIELDS)[T][number];
export type SourceFieldRef = {
  [T in SourceTable]: { readonly table: T; readonly field: SourceField<T> };
}[SourceTable];

// ---------------------------------------------------------------------------
// Request status groups and queue groups
// ---------------------------------------------------------------------------

/** Request statuses that are final outcomes for F19. */
export const TERMINAL_REQUEST_STATUSES = Object.freeze(["approved", "rejected"] as const);

/** Request statuses that are still awaiting a decision. */
export const PENDING_REQUEST_STATUSES = Object.freeze(["submitted", "under_review"] as const);

/**
 * Request statuses that are neither pending nor terminal for F19. No code path
 * sets `completed` today. In turnaround and approval rate such a request is
 * excluded and counted under the completed_status data-quality exclusion; it
 * is never treated as approved.
 */
export const EXCLUDED_REQUEST_STATUSES = Object.freeze(["completed"] as const);

/**
 * The group for stages whose queue_id is not a QueueId in
 * src/lib/routing/rules.ts. Queue groupings have one group per recognized
 * queue plus this one. Unknown-queue stages count in overall values and in
 * this group, never in a recognized queue.
 */
export const UNKNOWN_QUEUE_GROUP = "unknown";

// ---------------------------------------------------------------------------
// Load integrity
// ---------------------------------------------------------------------------

/**
 * Must hold before any metric is calculated. When it does not, the metric's
 * result is a load-integrity error: never a zero, never no-data, and never a
 * data-quality count.
 */
export const LOAD_INTEGRITY_PRECONDITION =
  "Every read a metric requires must succeed with complete row coverage and every required " +
  "field. Complete row coverage means every row the reader is permitted to see, across all " +
  "pages, within the metric's read coverage: for approval_stage_tracking, every stage record " +
  "with the statuses given by the metric's stageReadCoverage, for every supplied request when " +
  "requests are also read; and every supplied stage's request present in the request read. " +
  "Every required field means every source field the metric lists present on every returned " +
  "row. A null value is present and is judged by the data-quality conditions; an absent field " +
  "is missing. If any required read fails, is partial or is missing a required field, the " +
  "metric is not calculated and its result is a load-integrity error that blocks calculation: " +
  "never a zero-valued metric, never no-data, and never a data-quality exclusion. Data-quality " +
  "codes describe individual records of a complete dataset only.";

export const LOAD_INTEGRITY_ERROR_CODES = Object.freeze([
  "request_read_failed",
  "request_read_incomplete",
  "request_field_missing",
  "stage_read_failed",
  "stage_read_incomplete",
  "stage_field_missing",
  "stage_request_not_loaded",
] as const);
export type LoadIntegrityErrorCode = (typeof LOAD_INTEGRITY_ERROR_CODES)[number];

export interface LoadIntegrityError {
  readonly code: LoadIntegrityErrorCode;
  /** The reads whose failure or inconsistency produces this error. */
  readonly reads: readonly SourceTable[];
  readonly description: string;
}

export const LOAD_INTEGRITY_ERRORS: Readonly<Record<LoadIntegrityErrorCode, LoadIntegrityError>> =
  deepFreeze({
    request_read_failed: {
      code: "request_read_failed",
      reads: ["financial_requests"],
      description:
        "The financial_requests read returned an error, including a permission error, or did not complete.",
    },
    request_read_incomplete: {
      code: "request_read_incomplete",
      reads: ["financial_requests"],
      description:
        "The financial_requests read returned only part of the rows the reader may see, for example because of a page or row limit.",
    },
    request_field_missing: {
      code: "request_field_missing",
      reads: ["financial_requests"],
      description:
        "A returned financial_requests row lacks a source field the metric requires, for example because the column was not selected. This is a load or schema error, never a data-quality exclusion such as invalid_created_at.",
    },
    stage_read_failed: {
      code: "stage_read_failed",
      reads: ["approval_stage_tracking"],
      description:
        "The approval_stage_tracking read returned an error, including a permission error, or did not complete.",
    },
    stage_read_incomplete: {
      code: "stage_read_incomplete",
      reads: ["approval_stage_tracking"],
      description:
        "The approval_stage_tracking read returned only part of the rows the reader may see, did not cover every supplied request, or omitted stage statuses that the metric's stageReadCoverage requires (for example, only active stages).",
    },
    stage_field_missing: {
      code: "stage_field_missing",
      reads: ["approval_stage_tracking"],
      description:
        "A returned approval_stage_tracking row lacks a source field the metric requires, for example because the column was not selected. This is a load or schema error, never a data-quality exclusion such as stage_missing_completed_at.",
    },
    stage_request_not_loaded: {
      code: "stage_request_not_loaded",
      reads: ["financial_requests", "approval_stage_tracking"],
      description:
        "A supplied stage's request_id has no matching request in the supplied request dataset. This means the two reads are inconsistent (truncated, filtered differently or taken at different times), not necessarily that the database relationship is broken: request_id is a NOT NULL foreign key with ON DELETE CASCADE, and a stage is readable exactly when its request is.",
    },
  });

/** Which approval_stage_tracking records a metric's stage read must return in full. */
export type StageReadCoverage = "all-statuses" | "non-active-statuses";

export const STAGE_READ_COVERAGE: Readonly<Record<StageReadCoverage, string>> = deepFreeze({
  "all-statuses":
    "Every approval_stage_tracking record of any status (active, completed, skipped or cancelled) for every request in the supplied request dataset. A read of only active stages is incomplete.",
  "non-active-statuses":
    "Every approval_stage_tracking record whose status is not active. Active stages may also be returned; they are outside the metric's scope.",
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export type MetricStatistic = "count" | "distinct-count" | "average" | "median" | "ratio";

/** Definitions shared by every average and median variant. */
export const STATISTIC_DEFINITIONS = deepFreeze({
  average:
    "Arithmetic mean: the sum of the qualifying values divided by their count n. " +
    "Groupings pool individual values; an overall average is never an average of group averages. " +
    "When n = 0 the result is no-data, not 0.",
  median:
    "Middle value of the qualifying values sorted in ascending order. " +
    "When n is even, the mean of the two middle values. " +
    "When n = 0 the result is no-data, not 0.",
} as const satisfies Partial<Record<MetricStatistic, string>>);

// ---------------------------------------------------------------------------
// Data-quality codes
// ---------------------------------------------------------------------------

/** The kind of record a check or population applies to. */
export type RecordSubject = "request" | "stage";

/**
 * How a code affects a metric value.
 * - excluded: the record fails a population condition and does not
 *   contribute. It is counted under exactly one primary code.
 * - flagged: the record passed every condition and still contributes (as
 *   described); the flag is counted. A record can carry several flags.
 * - reported-separately: a count of records outside the metric value, with
 *   its own population.
 */
export type DataQualityTreatment = "excluded" | "flagged" | "reported-separately";

/** How data-quality codes are applied and counted. docs/F19_Efficiency_Metrics.md section 6 repeats these rules. */
export const DATA_QUALITY_RULES = Object.freeze([
  "Data-quality codes apply only after the load-integrity precondition holds.",
  "Records outside a metric's population scope are removed first and are not counted.",
  "Each remaining record is checked against the population conditions in order. The first condition it fails gives its one primary exclusion code, and later conditions are not checked for that record.",
  "Flags apply only to records that pass every condition, never remove them from the value, and a record can carry several flags. A request-level flag on a stage population (duplicate_active_stages) is counted once per request, from that request's stage records that pass every condition; those stage records stay included.",
  "Counts are reported per metric for the whole supplied dataset, not per reporting period, because many excluded records have no valid anchor instant.",
] as const);

export const DATA_QUALITY_CODES = Object.freeze([
  "prototype_request",
  "completed_status",
  "invalid_created_at",
  "untracked_terminal_request",
  "terminal_request_with_active_stage",
  "terminal_stage_invalid",
  "decision_before_creation",
  "orphaned_active_stage",
  "in_progress_stage",
  "skipped_or_cancelled_stage",
  "stage_missing_completed_at",
  "invalid_stage_timestamps",
  "duplicate_active_stages",
  "unknown_queue",
  "pending_without_stage",
] as const);
export type DataQualityCode = (typeof DATA_QUALITY_CODES)[number];

export interface DataQualityCheck {
  readonly code: DataQualityCode;
  readonly subject: RecordSubject;
  readonly treatment: DataQualityTreatment;
  readonly description: string;
}

export const DATA_QUALITY_CHECKS: Readonly<Record<DataQualityCode, DataQualityCheck>> = deepFreeze({
  prototype_request: {
    code: "prototype_request",
    subject: "request",
    treatment: "excluded",
    description:
      "Browser-only prototype request (the client-side prototype flag); it never reached the database.",
  },
  completed_status: {
    code: "completed_status",
    subject: "request",
    treatment: "excluded",
    description:
      "The request has status completed, which is not an F19 terminal outcome. The request is excluded and counted under this code as a data-quality exclusion; it is never treated as approved and never retained as a flagged record.",
  },
  invalid_created_at: {
    code: "invalid_created_at",
    subject: "request",
    treatment: "excluded",
    description:
      "financial_requests.created_at is present on the row but is null or not a full ISO-8601 timestamp with an offset (see toValidInstant). A created_at absent from the row is the load-integrity error request_field_missing instead.",
  },
  untracked_terminal_request: {
    code: "untracked_terminal_request",
    subject: "request",
    treatment: "excluded",
    description:
      "A decided request with no approval stage records (created before F16 stage tracking, or its workflow failed), so it has no trusted decision instant.",
  },
  terminal_request_with_active_stage: {
    code: "terminal_request_with_active_stage",
    subject: "request",
    treatment: "excluded",
    description:
      "A decided request that still has an active stage, so its decision was not recorded through the stage table.",
  },
  terminal_stage_invalid: {
    code: "terminal_stage_invalid",
    subject: "request",
    treatment: "excluded",
    description:
      "The request's highest-numbered stage is not completed with a valid completed_at, so no decision instant can be derived.",
  },
  decision_before_creation: {
    code: "decision_before_creation",
    subject: "request",
    treatment: "excluded",
    description:
      "The decision instant is earlier than created_at, which is only possible if created_at was altered.",
  },
  orphaned_active_stage: {
    code: "orphaned_active_stage",
    subject: "stage",
    treatment: "excluded",
    description:
      "An active stage whose request is no longer pending (approved, rejected or completed): an inconsistent stage left open, usually because the status was changed outside f16_record_approval_decision. It is never workload and never an ordinary in-progress stage.",
  },
  in_progress_stage: {
    code: "in_progress_stage",
    subject: "stage",
    treatment: "excluded",
    description:
      "An active stage of a pending request, so it has no processing time yet. Reported as an in-progress count.",
  },
  skipped_or_cancelled_stage: {
    code: "skipped_or_cancelled_stage",
    subject: "stage",
    treatment: "excluded",
    description: "The stage status is skipped or cancelled, so no decision was made.",
  },
  stage_missing_completed_at: {
    code: "stage_missing_completed_at",
    subject: "stage",
    treatment: "excluded",
    description:
      "The stage status is completed but its completed_at value is null. A completed_at absent from the row is the load-integrity error stage_field_missing instead.",
  },
  invalid_stage_timestamps: {
    code: "invalid_stage_timestamps",
    subject: "stage",
    treatment: "excluded",
    description:
      "started_at or completed_at is not a valid instant, or completed_at is earlier than started_at.",
  },
  duplicate_active_stages: {
    code: "duplicate_active_stages",
    subject: "request",
    treatment: "flagged",
    description:
      "A pending request has more than one active stage. The flag is counted once per request, not per stage. All of the request's active stage records stay included, and workload counts the request once per queue by distinct request_id, so the extra stages add no workload.",
  },
  unknown_queue: {
    code: "unknown_queue",
    subject: "stage",
    treatment: "flagged",
    description:
      "queue_id is not a QueueId in src/lib/routing/rules.ts. The stage stays in the metric: it counts in overall values and in the separate unknown group, never in a recognized queue, and is reported.",
  },
  pending_without_stage: {
    code: "pending_without_stage",
    subject: "request",
    treatment: "reported-separately",
    description:
      "A pending request (submitted or under_review) with no approval stage records at all, e.g. after a failed workflow start. It is not queue workload and is reported as its own count.",
  },
});

// ---------------------------------------------------------------------------
// Known limitations
// ---------------------------------------------------------------------------

export type LimitationResolution = "F19.2" | "F19.3" | "not-resolvable" | "by-design";

export const KNOWN_LIMITATION_IDS = Object.freeze([
  "created_at_client_writable",
  "stage_rows_directly_writable",
  "status_update_bypasses_stage_closure",
  "stage_constraints_unenforced",
  "stage_outcome_not_recorded",
  "historical_stage_gaps",
  "unbounded_reads",
  "role_scoped_visibility",
] as const);
export type KnownLimitationId = (typeof KNOWN_LIMITATION_IDS)[number];

export interface KnownLimitation {
  readonly id: KnownLimitationId;
  readonly resolvedBy: LimitationResolution;
  readonly description: string;
}

export const KNOWN_LIMITATIONS: Readonly<Record<KnownLimitationId, KnownLimitation>> = deepFreeze({
  created_at_client_writable: {
    id: "created_at_client_writable",
    resolvedBy: "F19.2",
    description:
      "created_at defaults to now() but a client-supplied value is kept on insert, and the owner can update it while the request is submitted. F5 does not log the change.",
  },
  stage_rows_directly_writable: {
    id: "stage_rows_directly_writable",
    resolvedBy: "F19.2",
    description:
      "Admin, reviewer and leadership roles can insert, update and delete approval_stage_tracking rows directly, including started_at and completed_at.",
  },
  status_update_bypasses_stage_closure: {
    id: "status_update_bypasses_stage_closure",
    resolvedBy: "F19.2",
    description:
      "RLS lets those roles update financial_requests.status directly. That leaves the active stage open, producing orphaned stages and decided requests without a trusted decision instant.",
  },
  stage_constraints_unenforced: {
    id: "stage_constraints_unenforced",
    resolvedBy: "F19.2",
    description:
      "queue_id is free text, and neither one active stage per request nor one stage per queue per request is a database constraint (only routing and f16_record_approval_decision maintain them).",
  },
  stage_outcome_not_recorded: {
    id: "stage_outcome_not_recorded",
    resolvedBy: "F19.2",
    description:
      "A rejected stage is stored as completed. Its outcome exists only in workflow_events, which is not a trusted source, so stage metrics cannot be split by outcome.",
  },
  historical_stage_gaps: {
    id: "historical_stage_gaps",
    resolvedBy: "not-resolvable",
    description:
      "Requests created before F16 stage tracking was in place on a given database, and requests whose workflow failed, have no stage records. The repository does not record when the F16 migration was applied, so no cutoff date is assumed. Past stage timings cannot be reconstructed, so these requests are excluded and counted.",
  },
  unbounded_reads: {
    id: "unbounded_reads",
    resolvedBy: "F19.3",
    description:
      "Existing request and stage reads are not paginated and may be truncated by the API row limit; the existing stage loader in requests-data.ts reads only active stages and hides read errors and duplicate active stages. Under the load-integrity precondition these gaps block calculation instead of skewing results.",
  },
  role_scoped_visibility: {
    id: "role_scoped_visibility",
    resolvedBy: "by-design",
    description:
      "RLS shows admin, reviewer and leadership users every request and stage, but requesters only their own, so institution-wide results are meaningful only for those roles.",
  },
});

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

/** What a metric value counts or measures. Ratios are fractions from 0 to 1. */
export type MetricUnit = "requests" | "stage-decisions" | "hours" | "ratio";

/**
 * overall: one value for the whole population, including unknown-queue
 * stages; queue: one value per recognized queue plus UNKNOWN_QUEUE_GROUP.
 */
export type MetricGrouping = "overall" | "queue";

/**
 * The value when nothing qualifies in a complete dataset: zero, or no-data
 * (undefined, never shown as 0). It never applies to a failed or partial
 * load, which is a load-integrity error instead.
 */
export type MetricEmptyResult = "zero" | "no-data";

export type PeriodAssignment =
  | {
      readonly mode: "period";
      /** The instant that must fall inside the half-open F18 period. */
      readonly anchor: SourceFieldRef;
      readonly description: string;
    }
  | {
      readonly mode: "snapshot";
      readonly description: string;
    };

/** One population requirement and the exclusion code for records that fail it. */
export interface PopulationCondition {
  readonly requirement: string;
  readonly exclusion: DataQualityCode;
}

export interface MetricPopulation {
  readonly subject: RecordSubject;
  /** Records outside the scope are removed before any condition and are not counted. */
  readonly scope: string;
  /** Checked in order; the first failing condition is the record's one primary exclusion code. */
  readonly conditions: readonly PopulationCondition[];
}

/** A count reported beside the metric value, with its own population. */
export interface SeparateReport {
  readonly code: DataQualityCode;
  readonly population: MetricPopulation;
}

export interface EfficiencyMetricDefinition {
  readonly id: EfficiencyMetricId;
  readonly family: EfficiencyMetricFamily;
  readonly name: string;
  readonly definition: string;
  readonly formula: string;
  readonly statistic: MetricStatistic;
  readonly unit: MetricUnit;
  readonly groupings: readonly MetricGrouping[];
  readonly emptyResult: MetricEmptyResult;
  readonly sources: readonly SourceFieldRef[];
  /** Reads that must satisfy LOAD_INTEGRITY_PRECONDITION. */
  readonly requiredReads: readonly SourceTable[];
  /** Stage records the stage read must return in full; null when stages are not read. */
  readonly stageReadCoverage: StageReadCoverage | null;
  /** Errors that block this metric; they are never data-quality codes. */
  readonly loadIntegrityErrors: readonly LoadIntegrityErrorCode[];
  readonly period: PeriodAssignment;
  readonly population: MetricPopulation;
  readonly flags: readonly DataQualityCode[];
  readonly separateReports: readonly SeparateReport[];
  readonly calculationRules: readonly string[];
  readonly limitations: readonly KnownLimitationId[];
}

const REQUEST_READ_ERRORS: readonly LoadIntegrityErrorCode[] = [
  "request_read_failed",
  "request_read_incomplete",
  "request_field_missing",
];
const STAGE_READ_ERRORS: readonly LoadIntegrityErrorCode[] = [
  "stage_read_failed",
  "stage_read_incomplete",
  "stage_field_missing",
];
const COMBINED_READ_ERRORS: readonly LoadIntegrityErrorCode[] = [
  ...REQUEST_READ_ERRORS,
  ...STAGE_READ_ERRORS,
  "stage_request_not_loaded",
];

const REAL_REQUEST: PopulationCondition = {
  requirement: "The request is a real database request, not a browser prototype.",
  exclusion: "prototype_request",
};

const VALID_CREATED_AT: PopulationCondition = {
  requirement: "created_at is a valid instant.",
  exclusion: "invalid_created_at",
};

const STAGE_PROCESSING_SOURCES: readonly SourceFieldRef[] = [
  { table: "approval_stage_tracking", field: "request_id" },
  { table: "approval_stage_tracking", field: "queue_id" },
  { table: "approval_stage_tracking", field: "status" },
  { table: "approval_stage_tracking", field: "started_at" },
  { table: "approval_stage_tracking", field: "completed_at" },
  { table: "financial_requests", field: "id" },
  { table: "financial_requests", field: "status" },
];

const STAGE_COMPLETION_PERIOD: PeriodAssignment = {
  mode: "period",
  anchor: { table: "approval_stage_tracking", field: "completed_at" },
  description:
    "A stage belongs to the period containing its completed_at, even if it started in an earlier period.",
};

const COMPLETED_STAGE_CONDITIONS: readonly PopulationCondition[] = [
  {
    requirement: "The stage is not skipped or cancelled.",
    exclusion: "skipped_or_cancelled_stage",
  },
  {
    requirement: "A completed stage has a completed_at.",
    exclusion: "stage_missing_completed_at",
  },
  {
    requirement:
      "started_at and completed_at are valid instants and completed_at is not earlier than started_at.",
    exclusion: "invalid_stage_timestamps",
  },
];

/**
 * The tracked terminal request population, shared by request turnaround and
 * approval rate so both describe exactly the same requests. Its conditions
 * are the complete definition of a tracked terminal request, in precedence
 * order.
 */
export const TRACKED_TERMINAL_POPULATION: MetricPopulation = deepFreeze({
  subject: "request",
  scope:
    "Requests whose status is approved, rejected or completed. Pending requests (submitted, under_review) are outside the population and are not counted.",
  conditions: [
    REAL_REQUEST,
    {
      requirement: "The status is approved or rejected; completed is never treated as approved.",
      exclusion: "completed_status",
    },
    VALID_CREATED_AT,
    {
      requirement: "The request has at least one approval stage record.",
      exclusion: "untracked_terminal_request",
    },
    {
      requirement: "None of the request's stages is active.",
      exclusion: "terminal_request_with_active_stage",
    },
    {
      requirement:
        "The highest-numbered stage has status completed and a valid completed_at; that completed_at is the decision instant T(r).",
      exclusion: "terminal_stage_invalid",
    },
    {
      requirement: "The decision instant T(r) is not earlier than created_at.",
      exclusion: "decision_before_creation",
    },
  ],
});

const TRACKED_TERMINAL_SOURCES: readonly SourceFieldRef[] = [
  { table: "financial_requests", field: "id" },
  { table: "financial_requests", field: "status" },
  { table: "financial_requests", field: "created_at" },
  { table: "approval_stage_tracking", field: "request_id" },
  { table: "approval_stage_tracking", field: "stage_order" },
  { table: "approval_stage_tracking", field: "status" },
  { table: "approval_stage_tracking", field: "completed_at" },
];

const TRACKED_TERMINAL_PERIOD: PeriodAssignment = {
  mode: "period",
  anchor: { table: "approval_stage_tracking", field: "completed_at" },
  description:
    "A request belongs to the period containing its decision instant: the completed_at of its highest-numbered stage. created_at does not decide the period.",
};

const TRACKED_TERMINAL_LIMITATIONS: readonly KnownLimitationId[] = [
  "created_at_client_writable",
  "stage_rows_directly_writable",
  "status_update_bypasses_stage_closure",
  "historical_stage_gaps",
  "unbounded_reads",
  "role_scoped_visibility",
];

const NO_WORKFLOW_EVENTS_RULE =
  "workflow_events is not used to find outcomes or decision instants.";

const STAGE_PROCESSING_TIME = {
  family: "stage_processing_time",
  unit: "hours",
  groupings: ["overall", "queue"],
  emptyResult: "no-data",
  sources: STAGE_PROCESSING_SOURCES,
  requiredReads: ["financial_requests", "approval_stage_tracking"],
  stageReadCoverage: "all-statuses",
  loadIntegrityErrors: COMBINED_READ_ERRORS,
  period: STAGE_COMPLETION_PERIOD,
  population: {
    subject: "stage",
    scope: "Every supplied approval stage record.",
    conditions: [
      {
        requirement:
          "The stage is not an active stage of a request that is no longer pending (approved, rejected or completed).",
        exclusion: "orphaned_active_stage",
      },
      {
        requirement: "The stage is not active.",
        exclusion: "in_progress_stage",
      },
      ...COMPLETED_STAGE_CONDITIONS,
    ],
  },
  flags: ["unknown_queue"],
  separateReports: [],
  calculationRules: [
    "Includes stages whose decision was a rejection.",
    "Includes completed stages of requests that are now approved, rejected or completed; request status affects only active stages.",
    "The overall value pools every remaining stage, including unknown-queue stages, and is not computed from group values. Queue groups cover each recognized queue plus the unknown group.",
  ],
  limitations: [
    "stage_rows_directly_writable",
    "status_update_bypasses_stage_closure",
    "stage_constraints_unenforced",
    "stage_outcome_not_recorded",
    "historical_stage_gaps",
    "unbounded_reads",
    "role_scoped_visibility",
  ],
} as const satisfies Partial<EfficiencyMetricDefinition>;

const REQUEST_TURNAROUND_TIME = {
  family: "request_turnaround_time",
  unit: "hours",
  groupings: ["overall"],
  emptyResult: "no-data",
  sources: TRACKED_TERMINAL_SOURCES,
  requiredReads: ["financial_requests", "approval_stage_tracking"],
  stageReadCoverage: "all-statuses",
  loadIntegrityErrors: COMBINED_READ_ERRORS,
  period: TRACKED_TERMINAL_PERIOD,
  population: TRACKED_TERMINAL_POPULATION,
  flags: [],
  separateReports: [],
  calculationRules: [
    "The duration starts at created_at, so it includes the intake gap before stage 1 starts.",
    NO_WORKFLOW_EVENTS_RULE,
  ],
  limitations: TRACKED_TERMINAL_LIMITATIONS,
} as const satisfies Partial<EfficiencyMetricDefinition>;

const STAGE_DURATION_FORMULA = "d(s) = (s.completed_at - s.started_at) / 3,600,000 ms";
const TURNAROUND_DURATION_FORMULA =
  "T(r) = completed_at of r's highest-numbered stage; TAT(r) = (T(r) - r.created_at) / 3,600,000 ms";

/** The F19 metric catalog, keyed by identifier. Deeply frozen. */
export const EFFICIENCY_METRICS: Readonly<Record<EfficiencyMetricId, EfficiencyMetricDefinition>> =
  deepFreeze({
    request_volume: {
      id: "request_volume",
      family: "request_volume",
      name: "Request Volume",
      definition:
        "The number of real financial requests received during a reporting period, regardless of status or outcome.",
      formula: "Volume(P) = |{ r in financial_requests : r.created_at in P }|",
      statistic: "count",
      unit: "requests",
      groupings: ["overall"],
      emptyResult: "zero",
      sources: [
        { table: "financial_requests", field: "id" },
        { table: "financial_requests", field: "created_at" },
      ],
      requiredReads: ["financial_requests"],
      stageReadCoverage: null,
      loadIntegrityErrors: REQUEST_READ_ERRORS,
      period: {
        mode: "period",
        anchor: { table: "financial_requests", field: "created_at" },
        description: "A request belongs to the period containing its created_at.",
      },
      population: {
        subject: "request",
        scope: "Every supplied request record, in any status.",
        conditions: [REAL_REQUEST, VALID_CREATED_AT],
      },
      flags: [],
      separateReports: [],
      calculationRules: [
        "Counts each remaining request once, whatever its status, including rejected, pending, completed and requests whose workflow failed.",
      ],
      limitations: ["created_at_client_writable", "unbounded_reads", "role_scoped_visibility"],
    },
    active_queue_workload: {
      id: "active_queue_workload",
      family: "active_queue_workload",
      name: "Active Queue Workload",
      definition:
        "The number of distinct requests currently waiting for a decision in each approval queue.",
      formula:
        "Workload(q, now) = |{ distinct s.request_id : s.status = 'active', s.queue_id = q, request(s).status in {submitted, under_review} }|",
      statistic: "distinct-count",
      unit: "requests",
      groupings: ["queue"],
      emptyResult: "zero",
      sources: [
        { table: "approval_stage_tracking", field: "request_id" },
        { table: "approval_stage_tracking", field: "queue_id" },
        { table: "approval_stage_tracking", field: "status" },
        { table: "financial_requests", field: "id" },
        { table: "financial_requests", field: "status" },
      ],
      requiredReads: ["financial_requests", "approval_stage_tracking"],
      stageReadCoverage: "all-statuses",
      loadIntegrityErrors: COMBINED_READ_ERRORS,
      period: {
        mode: "snapshot",
        description:
          "A point-in-time count of currently active stages. It is not assigned to reporting periods, and past workload is not reconstructed.",
      },
      population: {
        subject: "stage",
        scope: "Supplied approval stage records with status active.",
        conditions: [
          {
            requirement: "The stage's request is pending (submitted or under_review).",
            exclusion: "orphaned_active_stage",
          },
        ],
      },
      flags: ["duplicate_active_stages", "unknown_queue"],
      separateReports: [
        {
          code: "pending_without_stage",
          population: {
            subject: "request",
            scope:
              "Supplied requests with status submitted or under_review that have no approval stage records of any status.",
            conditions: [REAL_REQUEST],
          },
        },
      ],
      calculationRules: [
        "Counts each remaining request once per queue by distinct request_id, including stages past their SLA deadline.",
        "Every recognized queue reports a value, 0 when it has no active stages; unknown-queue stages count only in the unknown group.",
        "The stage read must return every approval_stage_tracking record of any status for every supplied request, not only active stages, so that a pending request is reported as pending_without_stage only when it has no stage records at all.",
      ],
      limitations: [
        "stage_rows_directly_writable",
        "status_update_bypasses_stage_closure",
        "stage_constraints_unenforced",
        "historical_stage_gaps",
        "unbounded_reads",
        "role_scoped_visibility",
      ],
    },
    stage_processing_time_average: {
      id: "stage_processing_time_average",
      ...STAGE_PROCESSING_TIME,
      name: "Average Stage Processing Time",
      definition:
        "The mean calendar time an approval queue takes from the start of a stage to its decision.",
      formula: `${STAGE_DURATION_FORMULA}; AvgStage(q, P) = (sum of d(s)) / n over remaining stages of queue group q with s.completed_at in P; the overall value pools all remaining stages`,
      statistic: "average",
    },
    stage_processing_time_median: {
      id: "stage_processing_time_median",
      ...STAGE_PROCESSING_TIME,
      name: "Median Stage Processing Time",
      definition:
        "The median calendar time an approval queue takes from the start of a stage to its decision.",
      formula: `${STAGE_DURATION_FORMULA}; MedianStage(q, P) = median of d(s) over the same stages as the average`,
      statistic: "median",
    },
    request_turnaround_time_average: {
      id: "request_turnaround_time_average",
      ...REQUEST_TURNAROUND_TIME,
      name: "Average Request Turnaround Time",
      definition:
        "The mean calendar time from when a request was received to its final approval or rejection.",
      formula: `${TURNAROUND_DURATION_FORMULA}; AvgTAT(P) = (sum of TAT(r)) / n over tracked terminal requests with T(r) in P`,
      statistic: "average",
    },
    request_turnaround_time_median: {
      id: "request_turnaround_time_median",
      ...REQUEST_TURNAROUND_TIME,
      name: "Median Request Turnaround Time",
      definition:
        "The median calendar time from when a request was received to its final approval or rejection.",
      formula: `${TURNAROUND_DURATION_FORMULA}; MedianTAT(P) = median of TAT(r) over the same requests as the average`,
      statistic: "median",
    },
    approval_rate: {
      id: "approval_rate",
      family: "approval_rate",
      name: "Approval Rate",
      definition:
        "Of the requests that reached a final decision in the period, the fraction that were approved. Distinct from the existing dashboard approvalRate in analytics-utils.ts.",
      formula:
        "ApprovalRate(P) = A / (A + R), where A and R count tracked terminal requests with status approved and rejected and T(r) in P; no-data when A + R = 0",
      statistic: "ratio",
      unit: "ratio",
      groupings: ["overall"],
      emptyResult: "no-data",
      sources: TRACKED_TERMINAL_SOURCES,
      requiredReads: ["financial_requests", "approval_stage_tracking"],
      stageReadCoverage: "all-statuses",
      loadIntegrityErrors: COMBINED_READ_ERRORS,
      period: TRACKED_TERMINAL_PERIOD,
      population: TRACKED_TERMINAL_POPULATION,
      flags: [],
      separateReports: [],
      calculationRules: [
        "Each request counts once by its final outcome, whichever stage decided it.",
        NO_WORKFLOW_EVENTS_RULE,
      ],
      limitations: TRACKED_TERMINAL_LIMITATIONS,
    },
    queue_throughput: {
      id: "queue_throughput",
      family: "queue_throughput",
      name: "Queue Throughput",
      definition:
        "The number of approval-stage decisions each queue completed during the period, including rejections.",
      formula:
        "Throughput(q, P) = |{ s : s.queue_id = q, s.status = 'completed', s.completed_at in P }|; the overall total includes the unknown group and counts stage decisions, not requests",
      statistic: "count",
      unit: "stage-decisions",
      groupings: ["overall", "queue"],
      emptyResult: "zero",
      sources: [
        { table: "approval_stage_tracking", field: "queue_id" },
        { table: "approval_stage_tracking", field: "status" },
        { table: "approval_stage_tracking", field: "started_at" },
        { table: "approval_stage_tracking", field: "completed_at" },
      ],
      requiredReads: ["approval_stage_tracking"],
      stageReadCoverage: "non-active-statuses",
      loadIntegrityErrors: STAGE_READ_ERRORS,
      period: STAGE_COMPLETION_PERIOD,
      population: {
        subject: "stage",
        scope:
          "Supplied approval stage records whose status is not active; an active stage has made no decision yet.",
        conditions: COMPLETED_STAGE_CONDITIONS,
      },
      flags: ["unknown_queue"],
      separateReports: [],
      calculationRules: [
        "Includes stages whose decision was a rejection.",
        "A multi-stage request counts once in each queue that completed one of its stages.",
        "Includes completed stages of requests that are now approved, rejected or completed.",
        "The overall total includes unknown-queue stages and counts stage decisions, not requests.",
      ],
      limitations: [
        "stage_rows_directly_writable",
        "stage_constraints_unenforced",
        "stage_outcome_not_recorded",
        "historical_stage_gaps",
        "unbounded_reads",
        "role_scoped_visibility",
      ],
    },
  });
