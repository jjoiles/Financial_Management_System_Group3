import type {
  CompleteTable,
  DatasetIntegrityResult,
  EfficiencyRequestRow,
  EfficiencyStageRow,
} from "@/lib/efficiency-data";
import {
  APPROVAL_STAGE_STATUSES,
  DATA_QUALITY_CHECKS,
  EFFICIENCY_METRICS,
  EFFICIENCY_METRIC_IDS,
  EXCLUDED_REQUEST_STATUSES,
  PENDING_REQUEST_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  type DataQualityCode,
  type EfficiencyMetricFamily,
  type EfficiencyMetricId,
  type LoadIntegrityErrorCode,
  type MetricPopulation,
  type SourceTable,
} from "@/lib/efficiency-metrics";
import {
  isRecognizedQueueId,
  selectDecisiveStage,
  type DatasetIndex,
} from "@/lib/efficiency-population";
import { hoursBetween } from "@/lib/efficiency-stats";
import { toValidInstant } from "@/lib/time-zones";

/**
 * F19.4.3: per-metric load-integrity gating.
 * F19.4.4: catalog-driven population classification.
 *
 * Pure and browser-safe. Decides whether each metric may be calculated from
 * an F19.3 load, and which records each metric's population includes,
 * excludes (with one primary code) and flags. It does not assign reporting
 * periods or calculate metric values.
 *
 * Records are never copied, changed or dropped: every helper returns the
 * caller's own row objects, in input order, inside new frozen containers.
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog's
 * definitions, the F19.4.2 dataset helpers (efficiency-population), the
 * F19.4.1 stats helpers and the F18 instant parser. Nothing it imports may
 * import it back.
 */

// ---------------------------------------------------------------------------
// Load-integrity gating
// ---------------------------------------------------------------------------

/** How a failed read was classified by F19.3 (access vs. unavailable). */
export type LoadReadIssue = Extract<DatasetIntegrityResult, { status: "blocked" }>["issue"];

/**
 * The complete tables a metric may use: exactly its catalog requiredReads,
 * never a table it does not require. A table here is a complete read, which
 * may have zero rows; an empty table is data, not a failure.
 */
export type MetricTables = {
  readonly financial_requests?: CompleteTable<EfficiencyRequestRow>;
  readonly approval_stage_tracking?: CompleteTable<EfficiencyStageRow>;
};

export type MetricLoadGate =
  | {
      /** The load was cancelled: no metric is calculated or blocked. */
      readonly status: "cancelled";
      readonly metricId: EfficiencyMetricId;
    }
  | {
      /**
       * The metric must not be calculated. Its result is this load-integrity
       * error, never 0, no-data or a data-quality count (section 3.3).
       */
      readonly status: "blocked";
      readonly metricId: EfficiencyMetricId;
      /** The load's errors that are in this metric's loadIntegrityErrors, in catalog order. */
      readonly errors: readonly LoadIntegrityErrorCode[];
      /** This metric's requiredReads whose read was not complete. */
      readonly incompleteTables: readonly SourceTable[];
      /**
       * The F19.3 classification of a failed read of one of this metric's
       * tables, or null. F19.3 classifies only the first failed read
       * (requests first), so when both reads failed a stage-only metric gets
       * null rather than the request read's classification.
       */
      readonly issue: LoadReadIssue;
      /** Every error on the load, including those that do not apply to this metric. */
      readonly loadErrors: readonly LoadIntegrityErrorCode[];
    }
  | {
      /** Every required read is complete and no blocking error applies. */
      readonly status: "ready";
      readonly metricId: EfficiencyMetricId;
      readonly tables: MetricTables;
    };

/** The complete reads of a load, per table; null where a read was not complete. */
function completeReads(load: Exclude<DatasetIntegrityResult, { status: "cancelled" }>) {
  if (load.status === "blocked") return load.completeTables;
  const { dataset } = load;
  return {
    financial_requests: { rows: dataset.requests, window: dataset.reads.financial_requests },
    approval_stage_tracking: {
      rows: dataset.stages,
      window: dataset.reads.approval_stage_tracking,
    },
  };
}

/**
 * Decides whether one metric can be calculated from an F19.3 load result
 * (DatasetIntegrityResult, or the loader's EfficiencyLoadResult).
 *
 * The metric's requiredReads and loadIntegrityErrors come from the catalog,
 * which is the only source of these requirements.
 *
 * - Cancelled load: "cancelled".
 * - Blocked when any of the load's errors is in the metric's
 *   loadIntegrityErrors, or any required read is not complete. So Request
 *   Volume is ready when only the stage read failed, and Queue Throughput is
 *   ready when only the request read failed or the reads disagree
 *   (stage_request_not_loaded).
 * - Otherwise "ready", with exactly the required tables.
 *
 * Pure: does not modify the load; the tables hold the load's own rows.
 */
export function gateMetricLoad(
  metricId: EfficiencyMetricId,
  load: DatasetIntegrityResult,
): MetricLoadGate {
  if (load.status === "cancelled") return Object.freeze({ status: "cancelled", metricId });

  const metric = EFFICIENCY_METRICS[metricId];
  const reads = completeReads(load);
  const loadErrors = load.status === "blocked" ? load.errors : [];

  const errors = metric.loadIntegrityErrors.filter((code) => loadErrors.includes(code));
  const incompleteTables = metric.requiredReads.filter((table) => reads[table] === null);

  if (errors.length > 0 || incompleteTables.length > 0) {
    const issue = load.status === "blocked" ? load.issue : null;
    const issueTable: SourceTable | null = loadErrors.includes("request_read_failed")
      ? "financial_requests"
      : loadErrors.includes("stage_read_failed")
        ? "approval_stage_tracking"
        : null;
    return Object.freeze({
      status: "blocked",
      metricId,
      errors: Object.freeze(errors),
      incompleteTables: Object.freeze(incompleteTables),
      issue: issueTable && metric.requiredReads.includes(issueTable) ? issue : null,
      loadErrors: Object.freeze([...loadErrors]),
    });
  }

  const tables: { -readonly [T in keyof MetricTables]: MetricTables[T] } = {};
  if (metric.requiredReads.includes("financial_requests")) {
    tables.financial_requests = reads.financial_requests ?? undefined;
  }
  if (metric.requiredReads.includes("approval_stage_tracking")) {
    tables.approval_stage_tracking = reads.approval_stage_tracking ?? undefined;
  }
  return Object.freeze({ status: "ready", metricId, tables: Object.freeze(tables) });
}

/** gateMetricLoad for every catalog metric, keyed by id in catalog order. */
export function gateAllMetrics(
  load: DatasetIntegrityResult,
): Readonly<Record<EfficiencyMetricId, MetricLoadGate>> {
  return Object.freeze(
    Object.fromEntries(EFFICIENCY_METRIC_IDS.map((id) => [id, gateMetricLoad(id, load)])) as Record<
      EfficiencyMetricId,
      MetricLoadGate
    >,
  );
}

// ---------------------------------------------------------------------------
// Population classification: the generic engine
// ---------------------------------------------------------------------------

/** An excluded record and its one primary exclusion code. */
export type ExcludedRecord<T> = { readonly record: T; readonly code: DataQualityCode };

/** An included record and every flag it carries (at least one). */
export type FlaggedRecord<T> = { readonly record: T; readonly flags: readonly DataQualityCode[] };

/**
 * The classification of one population. Records outside the scope appear
 * nowhere: they are not candidates and are never counted (DATA_QUALITY_RULES).
 */
export type PopulationResult<T> = {
  /** In-scope records: included.length + excluded.length. 0 for an empty population. */
  readonly inScope: number;
  /** In-scope records that passed every condition, in input order. */
  readonly included: readonly T[];
  /** In-scope records that failed a condition, in input order, each with its primary code. */
  readonly excluded: readonly ExcludedRecord<T>[];
  /** Every condition code of the population, in catalog order, with its count (0 when none). */
  readonly exclusionCounts: Readonly<Partial<Record<DataQualityCode, number>>>;
  /** Included records that carry flags, in input order. */
  readonly flagged: readonly FlaggedRecord<T>[];
  /**
   * Every flag code requested, in catalog order, with its count (0 when none).
   * A flag whose catalog subject is the population's subject counts records;
   * one whose subject differs (duplicate_active_stages, a request-level flag
   * on a stage population) counts groups, once per request.
   */
  readonly flagCounts: Readonly<Partial<Record<DataQualityCode, number>>>;
};

/**
 * A condition predicate returns true when the record FAILS the catalog
 * condition, so the record is excluded under that condition's code.
 */
export type ConditionPredicate<C> = (candidate: C) => boolean;

/** A flag tested on one included record. */
export type RecordFlagRule<C> = {
  readonly level: "record";
  readonly test: (candidate: C) => boolean;
};

/**
 * A flag tested on a group of included records sharing a key, counted once
 * per group. Used when the flag's catalog subject differs from the
 * population's subject; every record in a flagged group carries the flag.
 */
export type GroupFlagRule<C> = {
  readonly level: "group";
  readonly groupKey: (candidate: C) => string;
  readonly test: (group: readonly C[]) => boolean;
};

export type FlagRule<C> = RecordFlagRule<C> | GroupFlagRule<C>;

/**
 * The classification engine. Applies DATA_QUALITY_RULES 2-4 to one
 * population:
 *
 * 1. Candidates outside `inScope` are removed and not counted.
 * 2. Each remaining candidate is checked against `population.conditions` in
 *    catalog order; the first condition it fails is its one primary
 *    exclusion code, and later conditions are not checked.
 * 3. Flags are evaluated only on records that passed every condition. They
 *    never remove a record, and a record can carry several.
 *
 * Fails loudly (throws an Error, before looking at any record) when a
 * population condition has no predicate, a requested flag has no rule, or a
 * flag rule's level does not match the catalog subjects. Does not modify the
 * candidates or records; results hold the caller's records.
 */
export function classifyRecords<C, T>(options: {
  readonly population: MetricPopulation;
  readonly candidates: readonly C[];
  readonly recordOf: (candidate: C) => T;
  readonly inScope: (candidate: C) => boolean;
  readonly predicates: Readonly<Partial<Record<DataQualityCode, ConditionPredicate<C>>>>;
  readonly flags?: readonly DataQualityCode[];
  readonly flagRules?: Readonly<Partial<Record<DataQualityCode, FlagRule<C>>>>;
}): PopulationResult<T> {
  const { population, candidates, recordOf, inScope, predicates } = options;
  const flagCodes = options.flags ?? [];

  const conditions = population.conditions.map(({ exclusion }) => {
    const predicate = predicates[exclusion];
    if (!predicate) {
      throw new Error(
        `No predicate for catalog condition "${exclusion}" (${population.subject} population).`,
      );
    }
    return { code: exclusion, predicate };
  });
  const flagRules = flagCodes.map((code) => {
    const rule = options.flagRules?.[code];
    if (!rule) throw new Error(`No rule for catalog flag "${code}".`);
    const expected = DATA_QUALITY_CHECKS[code].subject === population.subject ? "record" : "group";
    if (rule.level !== expected) {
      throw new Error(
        `Flag "${code}" must be a ${expected}-level rule for a ${population.subject} population.`,
      );
    }
    return { code, rule };
  });

  const exclusionCounts: Partial<Record<DataQualityCode, number>> = {};
  for (const { code } of conditions) exclusionCounts[code] = 0;
  const flagCounts: Partial<Record<DataQualityCode, number>> = {};
  for (const code of flagCodes) flagCounts[code] = 0;

  const passing: C[] = [];
  const excluded: ExcludedRecord<T>[] = [];
  let inScopeCount = 0;
  for (const candidate of candidates) {
    if (!inScope(candidate)) continue;
    inScopeCount += 1;
    const failed = conditions.find(({ predicate }) => predicate(candidate));
    if (failed) {
      excluded.push(Object.freeze({ record: recordOf(candidate), code: failed.code }));
      exclusionCounts[failed.code] = (exclusionCounts[failed.code] ?? 0) + 1;
    } else {
      passing.push(candidate);
    }
  }

  const flagsOf = new Map<C, DataQualityCode[]>();
  const addFlag = (candidate: C, code: DataQualityCode) => {
    const list = flagsOf.get(candidate) ?? [];
    list.push(code);
    flagsOf.set(candidate, list);
  };
  for (const { code, rule } of flagRules) {
    if (rule.level === "record") {
      for (const candidate of passing) {
        if (!rule.test(candidate)) continue;
        addFlag(candidate, code);
        flagCounts[code] = (flagCounts[code] ?? 0) + 1;
      }
    } else {
      const groups = new Map<string, C[]>();
      for (const candidate of passing) {
        const key = rule.groupKey(candidate);
        groups.set(key, [...(groups.get(key) ?? []), candidate]);
      }
      for (const group of groups.values()) {
        if (!rule.test(group)) continue;
        for (const candidate of group) addFlag(candidate, code);
        flagCounts[code] = (flagCounts[code] ?? 0) + 1;
      }
    }
  }

  const flagged: FlaggedRecord<T>[] = [];
  for (const candidate of passing) {
    const flags = flagsOf.get(candidate);
    if (flags)
      flagged.push(Object.freeze({ record: recordOf(candidate), flags: Object.freeze(flags) }));
  }

  return Object.freeze({
    inScope: inScopeCount,
    included: Object.freeze(passing.map(recordOf)),
    excluded: Object.freeze(excluded),
    exclusionCounts: Object.freeze(exclusionCounts),
    flagged: Object.freeze(flagged),
    flagCounts: Object.freeze(flagCounts),
  });
}

// ---------------------------------------------------------------------------
// Population classification: F19 contexts, predicates and scopes
// ---------------------------------------------------------------------------

/** A request candidate: the row, its stages (any status, every revision) and whether it is a prototype. */
export type RequestCandidate<
  R extends EfficiencyRequestRow = EfficiencyRequestRow,
  S extends EfficiencyStageRow = EfficiencyStageRow,
> = { readonly record: R; readonly stages: readonly S[]; readonly prototype: boolean };

/** A stage candidate: the row and its request, when the request was loaded. */
export type StageCandidate<
  R extends EfficiencyRequestRow = EfficiencyRequestRow,
  S extends EfficiencyStageRow = EfficiencyStageRow,
> = { readonly record: S; readonly request: R | undefined };

const isOneOf = (values: readonly string[], value: unknown) =>
  typeof value === "string" && values.includes(value);

const isPendingStatus = (status: unknown) => isOneOf(PENDING_REQUEST_STATUSES, status);

/**
 * The decision instant T(r): the completed_at of the request's decisive stage
 * (highest (workflow_revision, stage_order), selectDecisiveStage), when that
 * stage is completed and its completed_at is a valid instant; otherwise null.
 */
export function decisionInstant(stages: readonly EfficiencyStageRow[]): Date | null {
  const decisive = selectDecisiveStage(stages);
  if (decisive.status !== "decisive" || decisive.stage.status !== "completed") return null;
  return toValidInstant(decisive.stage.completed_at);
}

/**
 * Request-condition predicates, keyed by the catalog exclusion code. Each
 * returns true when the request FAILS that condition. They are written to be
 * correct on their own; the catalog order decides which one is reported.
 */
export const REQUEST_CONDITION_PREDICATES: Readonly<
  Partial<Record<DataQualityCode, ConditionPredicate<RequestCandidate>>>
> = Object.freeze({
  prototype_request: (c) => c.prototype,
  completed_status: (c) => !isOneOf(TERMINAL_REQUEST_STATUSES, c.record.status),
  invalid_created_at: (c) => toValidInstant(c.record.created_at) === null,
  untracked_terminal_request: (c) => c.stages.length === 0,
  terminal_request_with_active_stage: (c) => c.stages.some((stage) => stage.status === "active"),
  terminal_stage_invalid: (c) => decisionInstant(c.stages) === null,
  decision_before_creation: (c) => {
    const decidedAt = decisionInstant(c.stages);
    if (!decidedAt) return false;
    const elapsed = hoursBetween(c.record.created_at, decidedAt);
    return !elapsed.ok && elapsed.reason === "end-before-start";
  },
});

/** Stage-condition predicates, keyed by the catalog exclusion code; true when the stage FAILS it. */
export const STAGE_CONDITION_PREDICATES: Readonly<
  Partial<Record<DataQualityCode, ConditionPredicate<StageCandidate>>>
> = Object.freeze({
  // Workload words it as "the request is pending"; stage processing as "not an
  // active stage of a request that is no longer pending". Within each scope
  // both fail exactly for an active stage whose request is not pending.
  orphaned_active_stage: (c) => c.record.status === "active" && !isPendingStatus(c.request?.status),
  in_progress_stage: (c) => c.record.status === "active",
  skipped_or_cancelled_stage: (c) =>
    c.record.status === "skipped" || c.record.status === "cancelled",
  unrecognized_stage_status: (c) => !isOneOf(APPROVAL_STAGE_STATUSES, c.record.status),
  stage_missing_completed_at: (c) =>
    c.record.status === "completed" &&
    (c.record.completed_at === null || c.record.completed_at === undefined),
  invalid_stage_timestamps: (c) => !hoursBetween(c.record.started_at, c.record.completed_at).ok,
});

/** Stage-population flag rules, keyed by the catalog flag code. */
export const STAGE_FLAG_RULES: Readonly<
  Partial<Record<DataQualityCode, FlagRule<StageCandidate>>>
> = Object.freeze({
  unknown_queue: { level: "record", test: (c) => !isRecognizedQueueId(c.record.queue_id) },
  duplicate_active_stages: {
    level: "group",
    groupKey: (c) => c.record.request_id,
    test: (group) => group.filter((c) => c.record.status === "active").length > 1,
  },
});

/** Request-population flag rules. The catalog defines none today. */
export const REQUEST_FLAG_RULES: Readonly<
  Partial<Record<DataQualityCode, FlagRule<RequestCandidate>>>
> = Object.freeze({});

type Scope =
  | { readonly subject: "request"; readonly test: (candidate: RequestCandidate) => boolean }
  | { readonly subject: "stage"; readonly test: (candidate: StageCandidate) => boolean };

const TRACKED_TERMINAL_SCOPE: Scope = {
  subject: "request",
  test: (c) =>
    isOneOf([...TERMINAL_REQUEST_STATUSES, ...EXCLUDED_REQUEST_STATUSES], c.record.status),
};

/**
 * Each metric family's population scope (the catalog's `scope` text, which
 * is prose). The catalog's subject is checked against these at run time.
 */
export const POPULATION_SCOPES: Readonly<Record<EfficiencyMetricFamily, Scope>> = Object.freeze({
  request_volume: { subject: "request", test: () => true },
  active_queue_workload: { subject: "stage", test: (c) => c.record.status === "active" },
  stage_processing_time: { subject: "stage", test: () => true },
  request_turnaround_time: TRACKED_TERMINAL_SCOPE,
  approval_rate: TRACKED_TERMINAL_SCOPE,
  // "Status is not active": a null or unrecognized status is in scope and
  // reaches unrecognized_stage_status.
  queue_throughput: { subject: "stage", test: (c) => c.record.status !== "active" },
});

/** Each separate report's population scope, keyed by its catalog code. */
export const SEPARATE_REPORT_SCOPES: Readonly<Partial<Record<DataQualityCode, Scope>>> =
  Object.freeze({
    pending_without_stage: {
      subject: "request",
      test: (c) => isPendingStatus(c.record.status) && c.stages.length === 0,
    },
  });

/** A population result tagged with its subject, so request and stage results stay typed. */
export type SubjectPopulationResult<R, S> =
  | ({ readonly subject: "request" } & PopulationResult<R>)
  | ({ readonly subject: "stage" } & PopulationResult<S>);

export type MetricClassification<R, S> = {
  readonly metricId: EfficiencyMetricId;
  /** The metric's population, with its catalog flags. */
  readonly population: SubjectPopulationResult<R, S>;
  /** Each separate report, keyed by its code; its count is `included.length`. */
  readonly separateReports: Readonly<
    Partial<Record<DataQualityCode, SubjectPopulationResult<R, S>>>
  >;
};

/**
 * Classifies one metric's population and separate reports from an indexed
 * dataset, using the catalog's scope subject, ordered conditions, flags and
 * separate reports.
 *
 * - `prototypeRequests` are browser-only requests. The caller must scope them
 *   to the signed-in owner (AGENTS.md); this function cannot check ownership.
 *   They have no stages and only ever count under prototype_request.
 * - Call only after gateMetricLoad returned "ready". For a metric that
 *   requires financial_requests, a stage whose request is not in the index
 *   would have blocked the load (stage_request_not_loaded), so it throws.
 *
 * Classification is not per reporting period (DATA_QUALITY_RULES 5): every
 * in-scope record is classified, whatever its anchor instant.
 */
export function classifyMetricPopulation<
  R extends EfficiencyRequestRow,
  S extends EfficiencyStageRow,
>(
  metricId: EfficiencyMetricId,
  input: { readonly index: DatasetIndex<R, S>; readonly prototypeRequests?: readonly R[] },
): MetricClassification<R, S> {
  const metric = EFFICIENCY_METRICS[metricId];
  const { index } = input;

  if (metric.requiredReads.includes("financial_requests") && index.unmatchedStages.length > 0) {
    throw new Error(
      `${metricId} needs every stage's request, but ${index.unmatchedStages.length} stage(s) have none; the load should have been blocked by stage_request_not_loaded.`,
    );
  }

  const requestCandidates: RequestCandidate<R, S>[] = [
    ...[...index.requestsById.values()].map((record) => ({
      record,
      stages: index.stagesByRequestId.get(record.id) ?? [],
      prototype: false,
    })),
    ...(input.prototypeRequests ?? []).map((record) => ({
      record,
      stages: [] as S[],
      prototype: true,
    })),
  ];
  const stageCandidates: StageCandidate<R, S>[] = index.stages.map((record) => ({
    record,
    request: index.requestsById.get(record.request_id),
  }));

  const classify = (
    population: MetricPopulation,
    scope: Scope | undefined,
    flags: readonly DataQualityCode[],
    label: string,
  ): SubjectPopulationResult<R, S> => {
    if (!scope) throw new Error(`No population scope for ${label}.`);
    if (scope.subject !== population.subject) {
      throw new Error(
        `Scope for ${label} is ${scope.subject}, but the catalog subject is ${population.subject}.`,
      );
    }
    if (scope.subject === "request") {
      const result = classifyRecords<RequestCandidate<R, S>, R>({
        population,
        candidates: requestCandidates,
        recordOf: (c) => c.record,
        inScope: scope.test,
        predicates: REQUEST_CONDITION_PREDICATES,
        flags,
        flagRules: REQUEST_FLAG_RULES,
      });
      return Object.freeze({ subject: "request" as const, ...result });
    }
    const result = classifyRecords<StageCandidate<R, S>, S>({
      population,
      candidates: stageCandidates,
      recordOf: (c) => c.record,
      inScope: scope.test,
      predicates: STAGE_CONDITION_PREDICATES,
      flags,
      flagRules: STAGE_FLAG_RULES,
    });
    return Object.freeze({ subject: "stage" as const, ...result });
  };

  const population = classify(
    metric.population,
    POPULATION_SCOPES[metric.family],
    metric.flags,
    metricId,
  );
  const separateReports: Partial<Record<DataQualityCode, SubjectPopulationResult<R, S>>> = {};
  for (const report of metric.separateReports) {
    separateReports[report.code] = classify(
      report.population,
      SEPARATE_REPORT_SCOPES[report.code],
      [],
      `${metricId} ${report.code}`,
    );
  }

  return Object.freeze({ metricId, population, separateReports: Object.freeze(separateReports) });
}
