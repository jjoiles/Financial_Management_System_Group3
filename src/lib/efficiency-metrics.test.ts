import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import * as catalogModule from "./efficiency-metrics";
import {
  APPROVAL_STAGE_STATUSES,
  DATA_QUALITY_CHECKS,
  DATA_QUALITY_CODES,
  DATA_QUALITY_RULES,
  DECISIVE_STAGE_ORDERING,
  EFFICIENCY_METRICS,
  EFFICIENCY_METRICS_VERSION,
  EFFICIENCY_METRIC_FAMILIES,
  EFFICIENCY_METRIC_IDS,
  EXCLUDED_REQUEST_STATUSES,
  KNOWN_LIMITATIONS,
  KNOWN_LIMITATION_IDS,
  LOAD_INTEGRITY_ERRORS,
  LOAD_INTEGRITY_ERROR_CODES,
  LOAD_INTEGRITY_PRECONDITION,
  PENDING_REQUEST_STATUSES,
  SOURCE_FIELDS,
  STAGE_READ_COVERAGE,
  STATISTIC_DEFINITIONS,
  TERMINAL_REQUEST_STATUSES,
  TRACKED_TERMINAL_POPULATION,
  UNKNOWN_QUEUE_GROUP,
  VERSION_BUMP_TRIGGERS,
  type DataQualityCode,
  type EfficiencyMetricDefinition,
  type EfficiencyMetricFamily,
  type EfficiencyMetricId,
  type KnownLimitationId,
  type LoadIntegrityErrorCode,
  type MetricPopulation,
  type RecordSubject,
  type SourceTable,
  type StageReadCoverage,
} from "./efficiency-metrics";

type RequestStatus = Database["public"]["Enums"]["request_status"];

// Compile-time check: every status the catalog names exists in the generated enum.
const CATALOG_STATUSES: readonly RequestStatus[] = [
  ...TERMINAL_REQUEST_STATUSES,
  ...PENDING_REQUEST_STATUSES,
  ...EXCLUDED_REQUEST_STATUSES,
];

const metrics = (): EfficiencyMetricDefinition[] =>
  EFFICIENCY_METRIC_IDS.map((id) => EFFICIENCY_METRICS[id]);

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const DOC = read("../../docs/F19_Efficiency_Metrics.md");

const conditionCodes = (population: MetricPopulation) =>
  population.conditions.map((condition) => condition.exclusion);

/** Every exclusion code a metric can assign, in precedence order: population, then separate reports. */
const exclusionCodes = (metric: EfficiencyMetricDefinition) => [
  ...conditionCodes(metric.population),
  ...metric.separateReports.flatMap((report) => conditionCodes(report.population)),
];

/** Every data-quality code a metric can report. */
const reportedCodes = (metric: EfficiencyMetricDefinition) =>
  new Set<DataQualityCode>([
    ...exclusionCodes(metric),
    ...metric.flags,
    ...metric.separateReports.map((report) => report.code),
  ]);

/**
 * The precedence rule from DATA_QUALITY_RULES, for testing the catalog's
 * condition order: the first condition a record fails is its primary code.
 */
function primaryExclusion(
  population: MetricPopulation,
  failing: ReadonlySet<DataQualityCode>,
): DataQualityCode | null {
  return (
    population.conditions.find((condition) => failing.has(condition.exclusion))?.exclusion ?? null
  );
}

/** The documentation section (### heading) that names the metric id. */
function section(id: EfficiencyMetricId): string {
  const sections = DOC.split(/^(?=### )/m);
  const found = sections.find((text) => text.split("\n")[0].includes(`\`${id}\``));
  if (!found) throw new Error(`No documentation section for ${id}`);
  return found;
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

// ---------------------------------------------------------------------------
// Approved expectations, written out independently of the catalog
// ---------------------------------------------------------------------------

const TERMINAL_EXCLUSIONS: DataQualityCode[] = [
  "prototype_request",
  "completed_status",
  "invalid_created_at",
  "untracked_terminal_request",
  "terminal_request_with_active_stage",
  "terminal_stage_invalid",
  "decision_before_creation",
];

const TERMINAL_LIMITATIONS: KnownLimitationId[] = [
  "created_at_unverified_before_hardening",
  "stage_rows_directly_writable",
  "status_update_bypasses_stage_closure",
  "historical_stage_gaps",
  "unbounded_reads",
  "non_atomic_reads",
  "role_scoped_visibility",
];

const STAGE_PROCESSING_EXPECTED = {
  subject: "stage" as RecordSubject,
  exclusions: [
    "orphaned_active_stage",
    "in_progress_stage",
    "skipped_or_cancelled_stage",
    "unrecognized_stage_status",
    "stage_missing_completed_at",
    "invalid_stage_timestamps",
  ] as DataQualityCode[],
  flags: ["unknown_queue"] as DataQualityCode[],
  separateReports: {} as Partial<Record<DataQualityCode, DataQualityCode[]>>,
  requiredReads: ["financial_requests", "approval_stage_tracking"] as SourceTable[],
  stageReadCoverage: "all-statuses" as StageReadCoverage | null,
  limitations: [
    "stage_rows_directly_writable",
    "status_update_bypasses_stage_closure",
    "stage_constraints_unenforced",
    "stage_outcome_not_recorded",
    "historical_stage_gaps",
    "unbounded_reads",
    "non_atomic_reads",
    "role_scoped_visibility",
  ] as KnownLimitationId[],
};

const TERMINAL_EXPECTED = {
  subject: "request" as RecordSubject,
  exclusions: TERMINAL_EXCLUSIONS,
  flags: [] as DataQualityCode[],
  separateReports: {} as Partial<Record<DataQualityCode, DataQualityCode[]>>,
  requiredReads: ["financial_requests", "approval_stage_tracking"] as SourceTable[],
  stageReadCoverage: "all-statuses" as StageReadCoverage | null,
  limitations: TERMINAL_LIMITATIONS,
};

const EXPECTED_RULES: Record<
  EfficiencyMetricId,
  {
    subject: RecordSubject;
    exclusions: DataQualityCode[];
    flags: DataQualityCode[];
    separateReports: Partial<Record<DataQualityCode, DataQualityCode[]>>;
    requiredReads: SourceTable[];
    stageReadCoverage: StageReadCoverage | null;
    limitations: KnownLimitationId[];
  }
> = {
  request_volume: {
    subject: "request",
    exclusions: ["prototype_request", "invalid_created_at"],
    flags: [],
    separateReports: {},
    requiredReads: ["financial_requests"],
    stageReadCoverage: null,
    limitations: [
      "created_at_unverified_before_hardening",
      "unbounded_reads",
      "non_atomic_reads",
      "role_scoped_visibility",
    ],
  },
  active_queue_workload: {
    subject: "stage",
    exclusions: ["orphaned_active_stage"],
    flags: ["duplicate_active_stages", "unknown_queue"],
    separateReports: { pending_without_stage: ["prototype_request"] },
    requiredReads: ["financial_requests", "approval_stage_tracking"],
    stageReadCoverage: "all-statuses",
    limitations: [
      "stage_rows_directly_writable",
      "status_update_bypasses_stage_closure",
      "stage_constraints_unenforced",
      "historical_stage_gaps",
      "unbounded_reads",
      "non_atomic_reads",
      "role_scoped_visibility",
    ],
  },
  stage_processing_time_average: STAGE_PROCESSING_EXPECTED,
  stage_processing_time_median: STAGE_PROCESSING_EXPECTED,
  request_turnaround_time_average: TERMINAL_EXPECTED,
  request_turnaround_time_median: TERMINAL_EXPECTED,
  approval_rate: TERMINAL_EXPECTED,
  queue_throughput: {
    subject: "stage",
    exclusions: [
      "skipped_or_cancelled_stage",
      "unrecognized_stage_status",
      "stage_missing_completed_at",
      "invalid_stage_timestamps",
    ],
    flags: ["unknown_queue"],
    separateReports: {},
    requiredReads: ["approval_stage_tracking"],
    stageReadCoverage: "non-active-statuses",
    limitations: [
      "stage_rows_directly_writable",
      "stage_constraints_unenforced",
      "stage_outcome_not_recorded",
      "historical_stage_gaps",
      "unbounded_reads",
      "non_atomic_reads",
      "role_scoped_visibility",
    ],
  },
};

// ---------------------------------------------------------------------------
// Catalog identity
// ---------------------------------------------------------------------------

describe("catalog identity and structure", () => {
  it("has a well-formed version", () => {
    expect(EFFICIENCY_METRICS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/);
  });

  it("defines exactly the catalog identifiers, keyed by their own id, in catalog order", () => {
    expect(Object.keys(EFFICIENCY_METRICS)).toEqual([...EFFICIENCY_METRIC_IDS]);
    for (const [key, metric] of Object.entries(EFFICIENCY_METRICS)) expect(metric.id).toBe(key);
    expect(new Set(EFFICIENCY_METRIC_IDS).size).toBe(EFFICIENCY_METRIC_IDS.length);
  });

  it("covers the six approved metric families", () => {
    expect([...EFFICIENCY_METRIC_FAMILIES]).toEqual([
      "request_volume",
      "active_queue_workload",
      "stage_processing_time",
      "request_turnaround_time",
      "approval_rate",
      "queue_throughput",
    ]);
    expect(new Set(metrics().map((metric) => metric.family))).toEqual(
      new Set(EFFICIENCY_METRIC_FAMILIES),
    );
  });

  it("is deeply frozen, including every shared constant", () => {
    for (const value of [
      EFFICIENCY_METRICS,
      DATA_QUALITY_CHECKS,
      DATA_QUALITY_RULES,
      LOAD_INTEGRITY_ERRORS,
      LOAD_INTEGRITY_ERROR_CODES,
      STAGE_READ_COVERAGE,
      TRACKED_TERMINAL_POPULATION,
      KNOWN_LIMITATIONS,
      STATISTIC_DEFINITIONS,
      SOURCE_FIELDS,
      DECISIVE_STAGE_ORDERING,
      VERSION_BUMP_TRIGGERS,
      EFFICIENCY_METRIC_IDS,
      EFFICIENCY_METRIC_FAMILIES,
      DATA_QUALITY_CODES,
      KNOWN_LIMITATION_IDS,
      TERMINAL_REQUEST_STATUSES,
      PENDING_REQUEST_STATUSES,
      EXCLUDED_REQUEST_STATUSES,
      APPROVAL_STAGE_STATUSES,
    ]) {
      expect(isDeeplyFrozen(value)).toBe(true);
    }
  });

  it("describes every metric with non-empty, trimmed text", () => {
    for (const metric of metrics()) {
      const texts = [
        metric.name,
        metric.definition,
        metric.formula,
        metric.population.scope,
        ...metric.population.conditions.map((condition) => condition.requirement),
        ...metric.calculationRules,
      ];
      for (const text of texts) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
      }
      expect(metric.groupings.length).toBeGreaterThan(0);
      expect(new Set(metric.groupings).size).toBe(metric.groupings.length);
    }
    expect(new Set(metrics().map((metric) => metric.name)).size).toBe(metrics().length);
  });
});

// ---------------------------------------------------------------------------
// Outputs, anchors and exact rule sets
// ---------------------------------------------------------------------------

describe("metric outputs", () => {
  const expected: Record<
    EfficiencyMetricId,
    Pick<EfficiencyMetricDefinition, "family" | "statistic" | "unit" | "groupings" | "emptyResult">
  > = {
    request_volume: {
      family: "request_volume",
      statistic: "count",
      unit: "requests",
      groupings: ["overall"],
      emptyResult: "zero",
    },
    active_queue_workload: {
      family: "active_queue_workload",
      statistic: "distinct-count",
      unit: "requests",
      groupings: ["queue"],
      emptyResult: "zero",
    },
    stage_processing_time_average: {
      family: "stage_processing_time",
      statistic: "average",
      unit: "hours",
      groupings: ["overall", "queue"],
      emptyResult: "no-data",
    },
    stage_processing_time_median: {
      family: "stage_processing_time",
      statistic: "median",
      unit: "hours",
      groupings: ["overall", "queue"],
      emptyResult: "no-data",
    },
    request_turnaround_time_average: {
      family: "request_turnaround_time",
      statistic: "average",
      unit: "hours",
      groupings: ["overall"],
      emptyResult: "no-data",
    },
    request_turnaround_time_median: {
      family: "request_turnaround_time",
      statistic: "median",
      unit: "hours",
      groupings: ["overall"],
      emptyResult: "no-data",
    },
    approval_rate: {
      family: "approval_rate",
      statistic: "ratio",
      unit: "ratio",
      groupings: ["overall"],
      emptyResult: "no-data",
    },
    queue_throughput: {
      family: "queue_throughput",
      statistic: "count",
      unit: "stage-decisions",
      groupings: ["overall", "queue"],
      emptyResult: "zero",
    },
  };

  it.each(EFFICIENCY_METRIC_IDS)("%s has the approved statistic, unit and grouping", (id) => {
    const { family, statistic, unit, groupings, emptyResult } = EFFICIENCY_METRICS[id];
    expect({ family, statistic, unit, groupings, emptyResult }).toEqual(expected[id]);
  });

  it("measures durations in calendar hours", () => {
    for (const metric of metrics().filter((m) => m.unit === "hours")) {
      expect(metric.formula).toContain("/ 3,600,000 ms");
      expect(metric.formula).not.toMatch(/business/i);
    }
  });

  it("offers average and median variants that differ only in statistic, name, definition and formula", () => {
    const pairs: [EfficiencyMetricId, EfficiencyMetricId][] = [
      ["stage_processing_time_average", "stage_processing_time_median"],
      ["request_turnaround_time_average", "request_turnaround_time_median"],
    ];
    for (const [averageId, medianId] of pairs) {
      const {
        statistic: a,
        name: _an,
        definition: _ad,
        formula: _af,
        id: _ai,
        ...average
      } = EFFICIENCY_METRICS[averageId];
      const {
        statistic: m,
        name: _mn,
        definition: _md,
        formula: _mf,
        id: _mi,
        ...median
      } = EFFICIENCY_METRICS[medianId];
      expect([a, m]).toEqual(["average", "median"]);
      expect(median).toEqual(average);
    }
  });

  it("defines average and median once, including the even-count and empty cases", () => {
    expect(STATISTIC_DEFINITIONS.average).toMatch(/never an average of group averages/);
    expect(STATISTIC_DEFINITIONS.median).toMatch(/even, the mean of the two middle values/);
    for (const definition of Object.values(STATISTIC_DEFINITIONS)) {
      expect(definition).toMatch(/n = 0 the result is no-data, not 0/);
    }
  });
});

describe("exact rules per metric", () => {
  it.each(EFFICIENCY_METRIC_IDS)(
    "%s has exactly the approved population, flags, reports, reads and limitations",
    (id) => {
      const metric = EFFICIENCY_METRICS[id];
      const want = EXPECTED_RULES[id];
      expect(metric.population.subject).toBe(want.subject);
      expect(conditionCodes(metric.population)).toEqual(want.exclusions);
      expect([...metric.flags]).toEqual(want.flags);
      expect(
        Object.fromEntries(
          metric.separateReports.map((report) => [report.code, conditionCodes(report.population)]),
        ),
      ).toEqual(want.separateReports);
      expect([...metric.requiredReads]).toEqual(want.requiredReads);
      expect(metric.stageReadCoverage).toBe(want.stageReadCoverage);
      expect([...metric.limitations].sort()).toEqual([...want.limitations].sort());
      expect(new Set(metric.limitations).size).toBe(metric.limitations.length);
    },
  );
});

describe("reporting-period assignment", () => {
  const anchors: Record<EfficiencyMetricId, string> = {
    request_volume: "financial_requests.created_at",
    active_queue_workload: "snapshot",
    stage_processing_time_average: "approval_stage_tracking.completed_at",
    stage_processing_time_median: "approval_stage_tracking.completed_at",
    request_turnaround_time_average: "approval_stage_tracking.completed_at",
    request_turnaround_time_median: "approval_stage_tracking.completed_at",
    approval_rate: "approval_stage_tracking.completed_at",
    queue_throughput: "approval_stage_tracking.completed_at",
  };

  it.each(EFFICIENCY_METRIC_IDS)("%s uses the approved anchor", (id) => {
    const { period } = EFFICIENCY_METRICS[id];
    const anchor =
      period.mode === "snapshot" ? "snapshot" : `${period.anchor.table}.${period.anchor.field}`;
    expect(anchor).toBe(anchors[id]);
    expect(period.description.length).toBeGreaterThan(0);
  });

  it("assigns decision metrics by the decisive (workflow_revision, stage_order) stage, not by created_at", () => {
    for (const id of ["request_turnaround_time_average", "approval_rate"] as const) {
      expect(EFFICIENCY_METRICS[id].period.description).toMatch(
        /highest \(workflow_revision, stage_order\)/,
      );
      expect(EFFICIENCY_METRICS[id].period.description).not.toMatch(/highest-numbered/);
    }
  });
});

// ---------------------------------------------------------------------------
// Load integrity
// ---------------------------------------------------------------------------

describe("load integrity", () => {
  it("keeps load-integrity errors separate from record-level data-quality codes", () => {
    const loadCodes = new Set<string>(LOAD_INTEGRITY_ERROR_CODES);
    for (const code of DATA_QUALITY_CODES) expect(loadCodes.has(code)).toBe(false);
    expect(DATA_QUALITY_CODES as readonly string[]).not.toContain("stage_request_missing");
    expect(Object.keys(LOAD_INTEGRITY_ERRORS)).toEqual([...LOAD_INTEGRITY_ERROR_CODES]);
    for (const [code, error] of Object.entries(LOAD_INTEGRITY_ERRORS)) {
      expect(error.code).toBe(code);
      expect(error.reads.length).toBeGreaterThan(0);
    }
  });

  it("requires exactly the reads that each metric's sources come from", () => {
    for (const metric of metrics()) {
      const tables = new Set(metric.sources.map((source) => source.table));
      expect(new Set(metric.requiredReads)).toEqual(tables);
    }
  });

  it("blocks each metric on every failure of its required reads, and on nothing else", () => {
    const expected: Record<EfficiencyMetricId, LoadIntegrityErrorCode[]> = {
      request_volume: ["request_read_failed", "request_read_incomplete", "request_field_missing"],
      active_queue_workload: [...LOAD_INTEGRITY_ERROR_CODES],
      stage_processing_time_average: [...LOAD_INTEGRITY_ERROR_CODES],
      stage_processing_time_median: [...LOAD_INTEGRITY_ERROR_CODES],
      request_turnaround_time_average: [...LOAD_INTEGRITY_ERROR_CODES],
      request_turnaround_time_median: [...LOAD_INTEGRITY_ERROR_CODES],
      approval_rate: [...LOAD_INTEGRITY_ERROR_CODES],
      queue_throughput: ["stage_read_failed", "stage_read_incomplete", "stage_field_missing"],
    };
    for (const metric of metrics()) {
      expect([...metric.loadIntegrityErrors].sort()).toEqual([...expected[metric.id]].sort());
      const derived = LOAD_INTEGRITY_ERROR_CODES.filter((code) =>
        LOAD_INTEGRITY_ERRORS[code].reads.every((table) => metric.requiredReads.includes(table)),
      );
      expect([...metric.loadIntegrityErrors].sort()).toEqual([...derived].sort());
    }
  });

  it("never represents a failed or partial load as a zero, no-data or data-quality result", () => {
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/never a zero-valued metric/);
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/never no-data/);
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/never a data-quality exclusion/);
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/blocks calculation/);
    expect(DATA_QUALITY_RULES[0]).toMatch(/only after the load-integrity precondition holds/);
    for (const metric of metrics()) {
      // A metric with an empty result of zero or no-data must still be blockable by its reads.
      expect(metric.loadIntegrityErrors.length).toBeGreaterThan(0);
      for (const code of metric.loadIntegrityErrors) {
        expect(reportedCodes(metric).has(code as never)).toBe(false);
      }
    }
  });

  it("treats a stage whose request is absent from the dataset as a load error, not a broken relationship", () => {
    const error = LOAD_INTEGRITY_ERRORS.stage_request_not_loaded;
    expect([...error.reads].sort()).toEqual(["approval_stage_tracking", "financial_requests"]);
    expect(error.description).toMatch(/not necessarily that the database relationship is broken/);
  });

  it("requires complete row coverage and every required field", () => {
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/complete row coverage and every required field/);
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(
      /every source field the metric lists present on every returned row/,
    );
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/is missing a required field/);
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(
      /A null value is present .*an absent field is missing/,
    );
    expect(LOAD_INTEGRITY_PRECONDITION).toMatch(/stageReadCoverage/);
  });

  it("treats a missing required field as a load error, never a data-quality exclusion", () => {
    expect([...LOAD_INTEGRITY_ERRORS.request_field_missing.reads]).toEqual(["financial_requests"]);
    expect([...LOAD_INTEGRITY_ERRORS.stage_field_missing.reads]).toEqual([
      "approval_stage_tracking",
    ]);
    for (const code of ["request_field_missing", "stage_field_missing"] as const) {
      expect(LOAD_INTEGRITY_ERRORS[code].description).toMatch(/never a data-quality exclusion/);
      expect(DATA_QUALITY_CODES as readonly string[]).not.toContain(code);
    }
    // Present-but-invalid values stay record-level codes and point to the load error for absence.
    expect(DATA_QUALITY_CHECKS.invalid_created_at.description).toMatch(/present on the row/);
    expect(DATA_QUALITY_CHECKS.invalid_created_at.description).toMatch(/request_field_missing/);
    expect(DATA_QUALITY_CHECKS.stage_missing_completed_at.description).toMatch(/value is null/);
    expect(DATA_QUALITY_CHECKS.stage_missing_completed_at.description).toMatch(
      /stage_field_missing/,
    );
    // Every metric is blocked by a missing field in each read it requires.
    for (const metric of metrics()) {
      if (metric.requiredReads.includes("financial_requests")) {
        expect(metric.loadIntegrityErrors).toContain("request_field_missing");
      }
      if (metric.requiredReads.includes("approval_stage_tracking")) {
        expect(metric.loadIntegrityErrors).toContain("stage_field_missing");
      }
    }
  });
});

describe("stage read coverage", () => {
  /** Codes that can only be decided by seeing active stages or the absence of any stage. */
  const NEEDS_EVERY_STAGE_STATUS: DataQualityCode[] = [
    "pending_without_stage",
    "untracked_terminal_request",
    "terminal_request_with_active_stage",
    "terminal_stage_invalid",
    "orphaned_active_stage",
    "in_progress_stage",
    "duplicate_active_stages",
  ];

  it("defines only all-statuses and non-active-statuses, never an active-only read", () => {
    expect(Object.keys(STAGE_READ_COVERAGE).sort()).toEqual([
      "all-statuses",
      "non-active-statuses",
    ]);
    expect(STAGE_READ_COVERAGE["all-statuses"]).toMatch(/of any status/);
    expect(STAGE_READ_COVERAGE["all-statuses"]).toMatch(
      /A read of only active stages is incomplete/,
    );
  });

  it("requires Active Queue Workload to read every stage record, whatever its status", () => {
    const workload = EFFICIENCY_METRICS.active_queue_workload;
    expect(workload.stageReadCoverage).toBe("all-statuses");
    expect(workload.calculationRules.join(" ")).toMatch(
      /every approval_stage_tracking record of any status for every supplied request, not only active stages/,
    );
    expect(LOAD_INTEGRITY_ERRORS.stage_read_incomplete.description).toMatch(
      /omitted stage statuses .* \(for example, only active stages\)/,
    );
  });

  it("requires all-statuses for every metric that detects active stages or missing stages", () => {
    for (const metric of metrics()) {
      const needsAll = [...reportedCodes(metric)].some((code) =>
        NEEDS_EVERY_STAGE_STATUS.includes(code),
      );
      if (needsAll) expect(metric.stageReadCoverage).toBe("all-statuses");
    }
  });

  it("declares a stage coverage exactly when the metric reads stages", () => {
    for (const metric of metrics()) {
      expect(metric.stageReadCoverage === null).toBe(
        !metric.requiredReads.includes("approval_stage_tracking"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Data-quality precedence and treatment
// ---------------------------------------------------------------------------

describe("data-quality precedence", () => {
  const populations = (): [string, MetricPopulation][] =>
    metrics().flatMap((metric) => [
      [`${metric.id} population`, metric.population] as [string, MetricPopulation],
      ...metric.separateReports.map(
        (report) =>
          [`${metric.id} ${report.code}`, report.population] as [string, MetricPopulation],
      ),
    ]);

  it("defines every code once, and every code is used by at least one metric", () => {
    expect(Object.keys(DATA_QUALITY_CHECKS)).toEqual([...DATA_QUALITY_CODES]);
    for (const [code, check] of Object.entries(DATA_QUALITY_CHECKS)) {
      expect(check.code).toBe(code);
      expect(check.description.length).toBeGreaterThan(0);
    }
    const used = new Set(metrics().flatMap((metric) => [...reportedCodes(metric)]));
    expect([...used].sort()).toEqual([...DATA_QUALITY_CODES].sort());
  });

  it("gives each exclusion exactly one place in each population, so a record gets one primary code", () => {
    for (const [, population] of populations()) {
      const codes = conditionCodes(population);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(DATA_QUALITY_CHECKS[code].treatment).toBe("excluded");
        expect(DATA_QUALITY_CHECKS[code].subject).toBe(population.subject);
      }
    }
  });

  it("assigns the earliest failing condition for every combination of failures", () => {
    for (const [, population] of populations()) {
      const codes = conditionCodes(population);
      for (let mask = 1; mask < 2 ** codes.length; mask += 1) {
        const failing = new Set(codes.filter((_, index) => mask & (1 << index)));
        const earliest = codes.find((code) => failing.has(code));
        expect(primaryExclusion(population, failing)).toBe(earliest);
      }
      expect(primaryExclusion(population, new Set())).toBeNull();
    }
  });

  it("resolves the section 5 precedence cases", () => {
    const volume = EFFICIENCY_METRICS.request_volume.population;
    const stages = EFFICIENCY_METRICS.stage_processing_time_average.population;
    const terminal = TRACKED_TERMINAL_POPULATION;
    const cases: [MetricPopulation, DataQualityCode[], DataQualityCode][] = [
      [volume, ["prototype_request", "invalid_created_at"], "prototype_request"],
      [terminal, ["completed_status", "untracked_terminal_request"], "completed_status"],
      [terminal, ["invalid_created_at", "untracked_terminal_request"], "invalid_created_at"],
      [terminal, ["terminal_request_with_active_stage"], "terminal_request_with_active_stage"],
      [stages, ["orphaned_active_stage", "in_progress_stage"], "orphaned_active_stage"],
      [
        stages,
        ["stage_missing_completed_at", "invalid_stage_timestamps"],
        "stage_missing_completed_at",
      ],
    ];
    for (const [population, failing, primary] of cases) {
      expect(primaryExclusion(population, new Set(failing))).toBe(primary);
    }
  });

  it("places unrecognized_stage_status immediately after skipped_or_cancelled_stage in both stage populations", () => {
    const throughput = EFFICIENCY_METRICS.queue_throughput.population;
    for (const population of [
      EFFICIENCY_METRICS.stage_processing_time_average.population,
      EFFICIENCY_METRICS.stage_processing_time_median.population,
      throughput,
    ]) {
      const codes = conditionCodes(population);
      expect(codes.indexOf("unrecognized_stage_status")).toBe(
        codes.indexOf("skipped_or_cancelled_stage") + 1,
      );
      expect(codes.indexOf("unrecognized_stage_status")).toBeLessThan(
        codes.indexOf("stage_missing_completed_at"),
      );
    }
    for (const metric of metrics()) {
      const used = exclusionCodes(metric).includes("unrecognized_stage_status");
      expect(used).toBe(
        metric.family === "stage_processing_time" || metric.id === "queue_throughput",
      );
    }
  });

  it("resolves unrecognized-status precedence: earlier status checks win, later completion checks lose", () => {
    const stages = EFFICIENCY_METRICS.stage_processing_time_average.population;
    const throughput = EFFICIENCY_METRICS.queue_throughput.population;
    const cases: [MetricPopulation, DataQualityCode[], DataQualityCode][] = [
      // An unrecognized status that is also missing completed_at or has bad timestamps.
      [
        stages,
        ["unrecognized_stage_status", "stage_missing_completed_at"],
        "unrecognized_stage_status",
      ],
      [
        stages,
        ["unrecognized_stage_status", "invalid_stage_timestamps"],
        "unrecognized_stage_status",
      ],
      [
        throughput,
        ["unrecognized_stage_status", "stage_missing_completed_at"],
        "unrecognized_stage_status",
      ],
      [
        throughput,
        ["unrecognized_stage_status", "invalid_stage_timestamps"],
        "unrecognized_stage_status",
      ],
      // Statuses the earlier conditions recognize keep their own code.
      [stages, ["orphaned_active_stage", "unrecognized_stage_status"], "orphaned_active_stage"],
      [stages, ["in_progress_stage", "unrecognized_stage_status"], "in_progress_stage"],
      [
        stages,
        ["skipped_or_cancelled_stage", "unrecognized_stage_status"],
        "skipped_or_cancelled_stage",
      ],
      [
        throughput,
        ["skipped_or_cancelled_stage", "unrecognized_stage_status"],
        "skipped_or_cancelled_stage",
      ],
      [throughput, ["unrecognized_stage_status"], "unrecognized_stage_status"],
    ];
    for (const [population, failing, primary] of cases) {
      expect(primaryExclusion(population, new Set(failing))).toBe(primary);
    }
  });

  it("orders conditions so later checks can rely on earlier ones", () => {
    const terminal = conditionCodes(TRACKED_TERMINAL_POPULATION);
    const before = (codes: DataQualityCode[], a: DataQualityCode, b: DataQualityCode) =>
      expect(codes.indexOf(a)).toBeLessThan(codes.indexOf(b));
    before(terminal, "invalid_created_at", "decision_before_creation");
    before(terminal, "terminal_stage_invalid", "decision_before_creation");
    before(terminal, "completed_status", "untracked_terminal_request");
    const stages = conditionCodes(EFFICIENCY_METRICS.stage_processing_time_average.population);
    before(stages, "orphaned_active_stage", "in_progress_stage");
    before(stages, "skipped_or_cancelled_stage", "unrecognized_stage_status");
    before(stages, "unrecognized_stage_status", "stage_missing_completed_at");
  });

  it("keeps flags and separate reports out of exclusions, with matching treatments", () => {
    for (const metric of metrics()) {
      const exclusions = new Set(exclusionCodes(metric));
      for (const flag of metric.flags) {
        expect(DATA_QUALITY_CHECKS[flag].treatment).toBe("flagged");
        expect(exclusions.has(flag)).toBe(false);
      }
      for (const report of metric.separateReports) {
        expect(DATA_QUALITY_CHECKS[report.code].treatment).toBe("reported-separately");
        expect(exclusions.has(report.code)).toBe(false);
      }
    }
  });

  it("states the precedence rules", () => {
    expect(DATA_QUALITY_RULES.join(" ")).toMatch(/removed first and are not counted/);
    expect(DATA_QUALITY_RULES.join(" ")).toMatch(/one primary exclusion code/);
    expect(DATA_QUALITY_RULES.join(" ")).toMatch(/never remove them/);
    expect(DATA_QUALITY_RULES.join(" ")).toMatch(/not per reporting period/);
  });
});

describe("specific record handling", () => {
  it("defines the complete tracked terminal population once for turnaround and approval rate", () => {
    for (const id of [
      "request_turnaround_time_average",
      "request_turnaround_time_median",
      "approval_rate",
    ] as const) {
      expect(EFFICIENCY_METRICS[id].population).toBe(TRACKED_TERMINAL_POPULATION);
      expect(EFFICIENCY_METRICS[id].sources).toEqual(EFFICIENCY_METRICS.approval_rate.sources);
      expect(EFFICIENCY_METRICS[id].period).toEqual(EFFICIENCY_METRICS.approval_rate.period);
    }
    expect(conditionCodes(TRACKED_TERMINAL_POPULATION)).toEqual(TERMINAL_EXCLUSIONS);
    const requirements = TRACKED_TERMINAL_POPULATION.conditions.map((c) => c.requirement);
    expect(requirements[2]).toMatch(/created_at is a valid instant/);
    expect(requirements[5]).toMatch(
      /decisive stage, the stage with the highest \(workflow_revision, stage_order\), has status completed/,
    );
    expect(requirements[6]).toMatch(/T\(r\) is not earlier than created_at/);
    expect(TRACKED_TERMINAL_POPULATION.scope).toMatch(/approved, rejected or completed/);
    expect(TRACKED_TERMINAL_POPULATION.scope).toMatch(/Pending requests .* are not counted/);
  });

  it("handles completed requests: in volume, excluded from decisions, orphaned if active, kept in stage metrics", () => {
    expect(conditionCodes(EFFICIENCY_METRICS.request_volume.population)).not.toContain(
      "completed_status",
    );
    expect(EFFICIENCY_METRICS.request_volume.calculationRules.join(" ")).toMatch(/completed/);
    expect(TRACKED_TERMINAL_POPULATION.conditions[1]).toEqual({
      requirement: "The status is approved or rejected; completed is never treated as approved.",
      exclusion: "completed_status",
    });
    expect(TERMINAL_REQUEST_STATUSES).not.toContain("completed");
    expect(DATA_QUALITY_CHECKS.completed_status.treatment).toBe("excluded");
    expect(DATA_QUALITY_CHECKS.completed_status.description).toMatch(
      /excluded and counted under this code as a data-quality exclusion/,
    );
    expect(DATA_QUALITY_CHECKS.completed_status.description).toMatch(
      /never retained as a flagged record/,
    );
    expect(DOC).not.toMatch(/approval rate and flagged/);
    expect(read("./efficiency-metrics.ts")).not.toMatch(/excluded and flagged/);
    expect(DATA_QUALITY_CHECKS.orphaned_active_stage.description).toMatch(
      /approved, rejected or completed/,
    );
    expect(EFFICIENCY_METRICS.active_queue_workload.population.conditions[0].requirement).toMatch(
      /pending \(submitted or under_review\)/,
    );
    for (const id of ["stage_processing_time_average", "queue_throughput"] as const) {
      expect(reportedCodes(EFFICIENCY_METRICS[id]).has("completed_status")).toBe(false);
      expect(EFFICIENCY_METRICS[id].calculationRules.join(" ")).toMatch(
        /completed stages of requests that are now approved, rejected or completed/,
      );
    }
  });

  it("never counts an orphaned active stage as workload or as an ordinary in-progress stage", () => {
    expect(conditionCodes(EFFICIENCY_METRICS.active_queue_workload.population)).toEqual([
      "orphaned_active_stage",
    ]);
    expect(
      primaryExclusion(
        EFFICIENCY_METRICS.stage_processing_time_average.population,
        new Set<DataQualityCode>(["orphaned_active_stage", "in_progress_stage"]),
      ),
    ).toBe("orphaned_active_stage");
    expect(DATA_QUALITY_CHECKS.orphaned_active_stage.treatment).toBe("excluded");
  });

  it("keeps unknown-queue stages in overall values and a separate group, flagged but not excluded", () => {
    expect(UNKNOWN_QUEUE_GROUP).toBe("unknown");
    expect(DATA_QUALITY_CHECKS.unknown_queue.treatment).toBe("flagged");
    expect(DATA_QUALITY_CHECKS.unknown_queue.description).toMatch(/counts in overall values/);
    expect(DATA_QUALITY_CHECKS.unknown_queue.description).toMatch(/never in a recognized queue/);
    for (const metric of metrics()) {
      expect(exclusionCodes(metric)).not.toContain("unknown_queue");
    }
    for (const id of ["stage_processing_time_average", "queue_throughput"] as const) {
      const metric = EFFICIENCY_METRICS[id];
      expect(metric.flags).toContain("unknown_queue");
      expect(metric.groupings).toEqual(["overall", "queue"]);
      expect(metric.calculationRules.join(" ")).toMatch(/overall .*includ\w* unknown-queue stages/);
    }
    expect(EFFICIENCY_METRICS.active_queue_workload.flags).toContain("unknown_queue");
  });

  it("counts the request-level duplicate_active_stages flag once per request and keeps its stages", () => {
    const check = DATA_QUALITY_CHECKS.duplicate_active_stages;
    expect(check.subject).toBe("request");
    expect(check.treatment).toBe("flagged");
    expect(EFFICIENCY_METRICS.active_queue_workload.population.subject).toBe("stage");
    expect(check.description).toMatch(/counted once per request, not per stage/);
    expect(check.description).toMatch(/active stage records stay included/);
    expect(check.description).toMatch(/add no workload/);
    expect(DATA_QUALITY_RULES[3]).toMatch(
      /request-level flag on a stage population \(duplicate_active_stages\) is counted once per request/,
    );
  });

  it("limits pending_without_stage to pending requests with no stage records at all", () => {
    const [report] = EFFICIENCY_METRICS.active_queue_workload.separateReports;
    expect(report.code).toBe("pending_without_stage");
    expect(report.population.subject).toBe("request");
    expect(report.population.scope).toMatch(/no approval stage records of any status/);
    expect(DATA_QUALITY_CHECKS.pending_without_stage.description).toMatch(
      /no approval stage records at all/,
    );
  });

  it("excludes prototype requests from every request population", () => {
    for (const metric of metrics()) {
      const requestPopulations = [
        metric.population,
        ...metric.separateReports.map((r) => r.population),
      ].filter((population) => population.subject === "request");
      for (const population of requestPopulations) {
        expect(conditionCodes(population)[0]).toBe("prototype_request");
      }
    }
  });

  it("includes rejected stages and counts throughput as stage decisions", () => {
    for (const id of ["stage_processing_time_average", "queue_throughput"] as const) {
      expect(EFFICIENCY_METRICS[id].calculationRules.join(" ")).toMatch(
        /stages whose decision was a rejection/,
      );
    }
    expect(EFFICIENCY_METRICS.queue_throughput.formula).toMatch(/stage decisions, not requests/);
    expect(EFFICIENCY_METRICS.queue_throughput.calculationRules.join(" ")).toMatch(
      /counts once in each queue/,
    );
    expect(EFFICIENCY_METRICS.approval_rate.formula).toMatch(/A \/ \(A \+ R\)/);
    expect(EFFICIENCY_METRICS.approval_rate.formula).toMatch(/no-data when A \+ R = 0/);
    expect(EFFICIENCY_METRICS.request_turnaround_time_average.calculationRules.join(" ")).toMatch(
      /intake gap before stage 1/,
    );
  });
});

describe("workflow revisions", () => {
  const terminalIds = [
    "request_turnaround_time_average",
    "request_turnaround_time_median",
    "approval_rate",
  ] as const;

  it("orders a request's stages by (workflow_revision, stage_order), revision first", () => {
    expect([...DECISIVE_STAGE_ORDERING]).toEqual(["workflow_revision", "stage_order"]);
    for (const field of DECISIVE_STAGE_ORDERING) {
      expect(SOURCE_FIELDS.approval_stage_tracking as readonly string[]).toContain(field);
    }
  });

  it("reads both ordering fields in every metric that derives a decision instant", () => {
    for (const metric of metrics()) {
      if (!exclusionCodes(metric).includes("terminal_stage_invalid")) continue;
      for (const field of DECISIVE_STAGE_ORDERING) {
        expect(metric.sources).toContainEqual({ table: "approval_stage_tracking", field });
      }
    }
    for (const id of terminalIds) {
      expect(EFFICIENCY_METRICS[id].population).toBe(TRACKED_TERMINAL_POPULATION);
    }
  });

  it("names the pair, never stage_order alone, wherever the decisive stage is described", () => {
    const texts = [
      DATA_QUALITY_CHECKS.terminal_stage_invalid.description,
      TRACKED_TERMINAL_POPULATION.conditions[5].requirement,
      ...terminalIds.flatMap((id) => [EFFICIENCY_METRICS[id].period.description]),
      EFFICIENCY_METRICS.request_turnaround_time_average.formula,
      EFFICIENCY_METRICS.request_turnaround_time_median.formula,
    ];
    for (const text of texts) {
      expect(text).toMatch(/highest \(workflow_revision, stage_order\)/);
    }
    expect(read("./efficiency-metrics.ts")).not.toMatch(/highest-numbered/);
    expect(DOC).not.toMatch(/highest-numbered/);
  });

  it("keeps turnaround measured from the original created_at, including pre-amendment time", () => {
    for (const id of [
      "request_turnaround_time_average",
      "request_turnaround_time_median",
    ] as const) {
      const metric = EFFICIENCY_METRICS[id];
      expect(metric.formula).toMatch(/TAT\(r\) = \(T\(r\) - r\.created_at\)/);
      expect(metric.calculationRules.join(" ")).toMatch(
        /amended request the duration still starts at the original created_at/,
      );
      expect(metric.calculationRules.join(" ")).toMatch(/time spent in earlier workflow revisions/);
    }
  });

  it("distinguishes the decisive stage from stages that only contribute elapsed time", () => {
    // The decisive stage must be completed: a cancelled stage can never supply T(r).
    expect(TRACKED_TERMINAL_POPULATION.conditions[5].requirement).toMatch(
      /has status completed and a valid completed_at/,
    );
    for (const id of [
      "request_turnaround_time_average",
      "request_turnaround_time_median",
    ] as const) {
      const rules = EFFICIENCY_METRICS[id].calculationRules.join(" ");
      expect(rules).toMatch(/Only the decisive stage supplies the decision instant T\(r\)/);
      expect(rules).toMatch(/cancelled stages of earlier revisions, are never decisive/);
      expect(rules).toMatch(/elapsed time lies inside the interval from created_at to T\(r\)/);
    }
    expect(DOC).toMatch(/A cancelled stage can never be decisive/);
    expect(DOC).toMatch(/H2 is cancelled, so it can never be the decisive stage/);
    expect(DOC).toMatch(/part of the turnaround and must be included for the identity to hold/);
  });

  it("defines integer ordering, ties and invalid keys for the decisive stage", () => {
    const texts = [
      DATA_QUALITY_CHECKS.terminal_stage_invalid.description,
      TRACKED_TERMINAL_POPULATION.conditions[5].requirement,
    ];
    for (const text of texts) {
      expect(text).toMatch(/compared as integers, revision first/);
      expect(text).toMatch(/two or more stages share the highest pair/);
      expect(text).toMatch(/null or non-integer workflow_revision or stage_order/);
    }
    expect(DATA_QUALITY_CHECKS.terminal_stage_invalid.description).toMatch(
      /revision 10 is newer than revision 9/,
    );
    expect(TRACKED_TERMINAL_POPULATION.conditions[5].exclusion).toBe("terminal_stage_invalid");
    const catalogComments = read("./efficiency-metrics.ts").replace(/\n\s*\* ?/g, " ");
    expect(catalogComments).toMatch(
      /compared as integers, not as text, so revision 10 is newer than revision 9/,
    );
    expect(DOC).toMatch(
      /compared as integers, not as text, so revision 10 is newer than revision 9/,
    );
    expect(DOC).toMatch(/two or more of its stages share the highest pair/);
    expect(DOC).toMatch(/null or non-integer `workflow_revision` or `stage_order`/);
    for (const id of ["request_turnaround_time_average", "approval_rate"] as const) {
      const row = section(id)
        .split("\n")
        .find(
          (line) =>
            line.endsWith("`terminal_stage_invalid`             |") ||
            /`terminal_stage_invalid`\s*\|$/.test(line),
        );
      expect(row).toMatch(/compared as integers/);
      expect(row).toMatch(/Ties at the highest pair and null or non-integer keys/);
    }
  });

  it("documents the amended-request worked example", () => {
    expect(DOC).toMatch(/### 5\.\d+ Amended request/);
    expect(DOC).toMatch(/revision 2/);
  });
});

// ---------------------------------------------------------------------------
// Sources and limitations
// ---------------------------------------------------------------------------

describe("stage statuses", () => {
  const migration = (name: string) => read(`../../supabase/migrations/${name}`);

  it("lists exactly the statuses the approval_stage_tracking CHECK constraint allows", () => {
    const f16 = migration("20261113160000_f16_sla_stage_tracking.sql");
    const check = f16.match(
      /status TEXT NOT NULL DEFAULT 'active'\s*CHECK\s*\(\s*status IN \(([^)]*)\)/,
    );
    expect(check).not.toBeNull();
    const allowed = [...(check?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...APPROVAL_STAGE_STATUSES]).toEqual(allowed);
    // F19.2 pairs each status with completed_at and adds no other status.
    const f19_2 = migration("20261119030549_f19_2_workflow_integrity.sql");
    const paired =
      f19_2.split("approval_stage_tracking_status_completed_check")[1]?.split(";")[0] ?? "";
    const named = new Set([...paired.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
    expect([...named].sort()).toEqual([...APPROVAL_STAGE_STATUSES].sort());
  });

  it("excludes an unrecognized or null status, never treating it as completed", () => {
    const check = DATA_QUALITY_CHECKS.unrecognized_stage_status;
    expect(check).toMatchObject({
      code: "unrecognized_stage_status",
      subject: "stage",
      treatment: "excluded",
    });
    expect(check.description).toMatch(/null or not one of APPROVAL_STAGE_STATUSES/);
    expect(check.description).toMatch(/never treated as completed/);
    expect(check.description).toMatch(/stage_field_missing/);
    const condition = EFFICIENCY_METRICS.queue_throughput.population.conditions.find(
      (c) => c.exclusion === "unrecognized_stage_status",
    );
    expect(condition?.requirement).toMatch(
      /one of APPROVAL_STAGE_STATUSES \(active, completed, skipped, cancelled\)/,
    );
    // A missing status column stays a load-integrity error.
    expect(LOAD_INTEGRITY_ERROR_CODES as readonly string[]).not.toContain(
      "unrecognized_stage_status",
    );
  });
});

describe("source fields", () => {
  const referencedFields = (metric: EfficiencyMetricDefinition) => [
    ...metric.sources,
    ...(metric.period.mode === "period" ? [metric.period.anchor] : []),
  ];

  it("only references allowlisted fields, and every allowlisted field is used", () => {
    const used = new Set<string>();
    for (const metric of metrics()) {
      for (const { table, field } of referencedFields(metric)) {
        expect(SOURCE_FIELDS[table] as readonly string[]).toContain(field);
        used.add(`${table}.${field}`);
      }
      const keys = metric.sources.map(({ table, field }) => `${table}.${field}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const allowlisted = Object.entries(SOURCE_FIELDS).flatMap(([table, fields]) =>
      fields.map((field) => `${table}.${field}`),
    );
    expect([...used].sort()).toEqual(allowlisted.sort());
  });

  it("never uses workflow_events, updated_at or the unused stage id", () => {
    expect(Object.keys(SOURCE_FIELDS)).not.toContain("workflow_events");
    for (const fields of Object.values(SOURCE_FIELDS)) {
      expect(fields as readonly string[]).not.toContain("updated_at");
    }
    expect(SOURCE_FIELDS.approval_stage_tracking as readonly string[]).not.toContain("id");
  });

  it("lists every period anchor among the metric's own sources", () => {
    for (const metric of metrics()) {
      if (metric.period.mode !== "period") continue;
      expect(metric.sources).toContainEqual(metric.period.anchor);
    }
  });

  it("reads every field its conditions check", () => {
    const has = (metric: EfficiencyMetricDefinition, table: SourceTable, field: string) =>
      metric.sources.some((source) => source.table === table && source.field === field);
    for (const metric of metrics()) {
      const codes = exclusionCodes(metric);
      if (codes.includes("invalid_stage_timestamps")) {
        expect(has(metric, "approval_stage_tracking", "started_at")).toBe(true);
        expect(has(metric, "approval_stage_tracking", "completed_at")).toBe(true);
      }
      if (codes.includes("orphaned_active_stage")) {
        expect(has(metric, "financial_requests", "status")).toBe(true);
        expect(has(metric, "approval_stage_tracking", "request_id")).toBe(true);
      }
      if (codes.includes("invalid_created_at")) {
        expect(has(metric, "financial_requests", "created_at")).toBe(true);
      }
      if (codes.includes("unrecognized_stage_status")) {
        expect(has(metric, "approval_stage_tracking", "status")).toBe(true);
      }
    }
  });
});

describe("known limitations", () => {
  it("defines every limitation once and uses each in at least one metric", () => {
    expect(Object.keys(KNOWN_LIMITATIONS)).toEqual([...KNOWN_LIMITATION_IDS]);
    for (const [id, limitation] of Object.entries(KNOWN_LIMITATIONS)) {
      expect(limitation.id).toBe(id);
      expect(["F19.2", "F19.3", "not-resolvable", "by-design"]).toContain(limitation.resolvedBy);
      expect(limitation.description.length).toBeGreaterThan(0);
    }
    const used = new Set(metrics().flatMap((metric) => metric.limitations));
    expect([...used].sort()).toEqual([...KNOWN_LIMITATION_IDS].sort());
  });

  it("assigns integrity gaps to F19.2 and loading gaps to F19.3", () => {
    expect(
      KNOWN_LIMITATION_IDS.filter((id) => KNOWN_LIMITATIONS[id].resolvedBy === "F19.2"),
    ).toEqual([
      "stage_rows_directly_writable",
      "status_update_bypasses_stage_closure",
      "stage_constraints_unenforced",
      "stage_outcome_not_recorded",
    ]);
    expect(KNOWN_LIMITATIONS.unbounded_reads.resolvedBy).toBe("F19.3");
    expect(KNOWN_LIMITATIONS.historical_stage_gaps.resolvedBy).toBe("not-resolvable");
    expect(KNOWN_LIMITATIONS.created_at_unverified_before_hardening.resolvedBy).toBe(
      "not-resolvable",
    );
  });

  it("applies non_atomic_reads to every metric, separating pagination from cross-table timing", () => {
    const limitation = KNOWN_LIMITATIONS.non_atomic_reads;
    expect(limitation.resolvedBy).toBe("by-design");
    expect(limitation.description).toMatch(/not a single database snapshot/);
    // Pagination applies to every metric, including the single-table ones.
    expect(limitation.description).toMatch(/Pagination, which affects every metric/);
    expect(limitation.description).toMatch(/even a single-table read/);
    for (const metric of metrics()) {
      expect(metric.limitations).toContain("non_atomic_reads");
    }
    const singleTable = metrics().filter((metric) => metric.requiredReads.length === 1);
    expect(singleTable.map((metric) => metric.id).sort()).toEqual([
      "queue_throughput",
      "request_volume",
    ]);
    expect(limitation.description).toMatch(/Request Volume's financial_requests read/);
    expect(limitation.description).toMatch(/Queue Throughput's approval_stage_tracking read/);
    // Cross-table timing is scoped to metrics that read both tables.
    expect(limitation.description).toMatch(
      /Cross-table timing, which affects only metrics that require both financial_requests and approval_stage_tracking/,
    );
    const docLimitations = DOC.split(/^## 7\. /m)[1]?.split(/^## /m)[0] ?? "";
    expect(docLimitations).toMatch(/\*\*Pagination \(all eight metrics\)\.\*\*/);
    expect(docLimitations).toMatch(/\*\*Cross-table timing \(six metrics\)\.\*\*/);
    const workload = EFFICIENCY_METRICS.active_queue_workload.period;
    expect(workload.mode).toBe("snapshot");
    expect(workload.description).toMatch(/read interval, not a single instant/);
  });

  it("never claims that count or pagination checks prove stable rows or a consistent snapshot", () => {
    const limitation = KNOWN_LIMITATIONS.non_atomic_reads.description;
    expect(limitation).toMatch(/validates pagination completeness and per-table counts/);
    expect(limitation).toMatch(/do not show that rows stayed unchanged/);
    expect(limitation).toMatch(/cannot guarantee a consistent snapshot/);
    expect(limitation).toMatch(/offset each other/);
    expect(limitation).toMatch(/changed after it was read/);
    const docLimitations = DOC.split(/^## 7\. /m)[1]?.split(/^## /m)[0] ?? "";
    expect(docLimitations).toMatch(
      /matching counts do \*\*not\*\* show that rows stayed unchanged/,
    );
    expect(docLimitations).toMatch(/cannot guarantee a consistent snapshot/);
    const overclaim =
      /\bproves?\b[^.\n]*\b(stable|unchanged|consistent|snapshot)\b|stable while it was read/i;
    expect(limitation).not.toMatch(overclaim);
    expect(DOC).not.toMatch(overclaim);
    expect(read("./efficiency-metrics.ts")).not.toMatch(overclaim);
  });

  it("does not assert an unverified F16 deployment date", () => {
    expect(KNOWN_LIMITATIONS.historical_stage_gaps.description).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(KNOWN_LIMITATIONS.historical_stage_gaps.description).toMatch(
      /no cutoff date is assumed/,
    );
    expect(DOC).not.toMatch(/2026-11-13/);
  });

  it("flags created_at integrity on exactly the metrics that read created_at", () => {
    for (const metric of metrics()) {
      const readsCreatedAt = metric.sources.some(
        (source) => source.table === "financial_requests" && source.field === "created_at",
      );
      expect(metric.limitations.includes("created_at_unverified_before_hardening")).toBe(
        readsCreatedAt,
      );
    }
  });

  it("agrees with the migration that makes created_at database-controlled and immutable", () => {
    expect([...KNOWN_LIMITATION_IDS] as string[]).not.toContain("created_at_client_writable");
    const limitation = KNOWN_LIMITATIONS.created_at_unverified_before_hardening;
    const migrationName = "20261119120100_f19_5_4_1_security_hardening";
    expect(limitation.description).toContain(migrationName);
    expect(limitation.description).toMatch(
      /assigns created_at on insert and rejects every later change/,
    );
    expect(limitation.description).toMatch(/cannot be verified/);
    const migration = read(`../../supabase/migrations/${migrationName}.sql`);
    expect(migration).toMatch(
      /CREATE TRIGGER f19_assign_request_created_at\s+BEFORE INSERT ON public\.financial_requests/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER zz_f19_guard_request_created_at\s+BEFORE INSERT OR UPDATE ON public\.financial_requests/,
    );
  });
});

// ---------------------------------------------------------------------------
// Documentation agreement
// ---------------------------------------------------------------------------

describe("documentation agrees with the catalog", () => {
  const docConditionCodes = (text: string) =>
    [...text.matchAll(/^\|\s*\d+\s*\|.*\|\s*`([a-z_]+)`\s*\|\s*$/gm)].map((match) => match[1]);

  it("lists every condition table in the same precedence order", () => {
    for (const metric of metrics()) {
      expect(docConditionCodes(section(metric.id))).toEqual(exclusionCodes(metric));
    }
  });

  it("lists every metric's flags", () => {
    for (const metric of metrics()) {
      const line = section(metric.id)
        .split("\n")
        .find((text) => text.startsWith("**Flags:**"));
      expect(line).toBeDefined();
      const flags = [...(line ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
      expect(flags).toEqual([...metric.flags]);
    }
  });

  it("matches the section 6 table: subject, treatment and the metrics that use each code", () => {
    const rows = [
      ...DOC.matchAll(
        /^\|\s*`([a-z_]+)`\s*\|\s*(request|stage)\s*\|\s*(excluded|flagged|reported separately)\s*\|(.*)\|\s*$/gm,
      ),
    ];
    const documented = Object.fromEntries(
      rows.map(([, code, subject, treatment, usedBy]) => [
        code,
        {
          subject,
          treatment: treatment.replace(" ", "-"),
          usedBy: [...usedBy.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).sort(),
        },
      ]),
    );
    const expected = Object.fromEntries(
      DATA_QUALITY_CODES.map((code) => {
        const families = new Set<EfficiencyMetricFamily>(
          metrics()
            .filter((metric) => reportedCodes(metric).has(code))
            .map((metric) => metric.family),
        );
        return [
          code,
          {
            subject: DATA_QUALITY_CHECKS[code].subject,
            treatment: DATA_QUALITY_CHECKS[code].treatment,
            usedBy: [...families].sort(),
          },
        ];
      }),
    );
    expect(documented).toEqual(expected);
  });

  it("documents every load-integrity error, the precondition and the precedence rules verbatim", () => {
    const documentedLoadCodes = [
      ...DOC.matchAll(
        /^\|\s*`([a-z_]+)`\s*\|\s*`(?:financial_requests|approval_stage_tracking)`/gm,
      ),
    ].map((match) => match[1]);
    expect(documentedLoadCodes).toEqual([...LOAD_INTEGRITY_ERROR_CODES]);
    expect(DOC).toContain(LOAD_INTEGRITY_PRECONDITION);
    for (const rule of DATA_QUALITY_RULES) expect(DOC).toContain(rule);
  });

  it("matches the section 3.3 stage read coverage table", () => {
    const labels: Record<EfficiencyMetricFamily, string> = {
      request_volume: "Request Volume",
      active_queue_workload: "Active Queue Workload",
      stage_processing_time: "Stage Processing Time",
      request_turnaround_time: "Request Turnaround Time",
      approval_rate: "Approval Rate",
      queue_throughput: "Queue Throughput",
    };
    const rows = new Map(
      [
        ...DOC.matchAll(
          /^\|\s*([A-Za-z ]+?)\s*\|[^|\n]*\|\s*(`all-statuses`|`non-active-statuses`|—)\s*\|[^|\n]*\|\s*$/gm,
        ),
      ].map(([, label, coverage]) => [label, coverage.replace(/`/g, "")]),
    );
    expect(rows.size).toBe(EFFICIENCY_METRIC_FAMILIES.length);
    for (const metric of metrics()) {
      expect(rows.get(labels[metric.family])).toBe(metric.stageReadCoverage ?? "—");
    }
  });

  it("lists the same version-bump triggers as the catalog", () => {
    const versioning = DOC.split(/^## 9\. /m)[1]?.split(/^## /m)[0] ?? "";
    const documented = [...versioning.matchAll(/^ {2}- (.+)$/gm)].map((match) => match[1]);
    expect(documented).toEqual([...VERSION_BUMP_TRIGGERS]);
  });

  it("states the same commit-based versioning policy in the catalog and section 9", () => {
    const policy =
      "The version identifies the catalog as committed. Changes made before the first commit are part of `2026-11-18.1`; every change after it requires a bump.";
    const versioning = DOC.split(/^## 9\. /m)[1]?.split(/^## /m)[0] ?? "";
    expect(versioning).toContain(policy);
    // Join the catalog's JSDoc lines so wrapping does not matter.
    const catalogComments = read("./efficiency-metrics.ts").replace(/\n\s*\* ?/g, " ");
    expect(catalogComments).toContain(policy);
    expect(EFFICIENCY_METRICS_VERSION).toBe("2026-11-19.2");
    expect(versioning).toMatch(
      new RegExp(`^\\| \`${EFFICIENCY_METRICS_VERSION.replace(/\./g, "\\.")}\` +\\|`, "m"),
    );
  });

  it("lists every known limitation in the section 7 table with its resolution", () => {
    const limitations = DOC.split(/^## 7\. /m)[1]?.split(/^## /m)[0] ?? "";
    const rows = Object.fromEntries(
      [...limitations.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|/gm)].map(
        ([, id, resolvedBy]) => [id, resolvedBy.replace(" ", "-")],
      ),
    );
    expect(Object.keys(rows)).toEqual([...KNOWN_LIMITATION_IDS]);
    for (const id of KNOWN_LIMITATION_IDS) {
      expect(rows[id]).toBe(KNOWN_LIMITATIONS[id].resolvedBy);
    }
  });

  it("lists the same source fields as SOURCE_FIELDS in section 3.4", () => {
    const line = DOC.split("\n").find((text) => text.startsWith("- Only `financial_requests`"));
    expect(line).toBeDefined();
    for (const [table, fields] of Object.entries(SOURCE_FIELDS)) {
      const listed = (line ?? "").split(`\`${table}\` (`)[1]?.split(")")[0] ?? "";
      expect([...listed.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])).toEqual([...fields]);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema: replay the whole migration history
// ---------------------------------------------------------------------------

type SchemaHistory = {
  columns: Map<string, Set<string>>;
  removedColumns: Map<string, Set<string>>;
  removedTables: Set<string>;
  enumValues: Map<string, Set<string>>;
  removedEnumValues: Map<string, Set<string>>;
  removedTypes: Set<string>;
};

const NAME = String.raw`(?:"?\w+"?\.)?"?(\w+)"?`;
const CONSTRAINT_ITEM = /^(constraint|primary|unique|check|foreign|exclude|like)\b/i;

/** Removes comments and dollar-quoted bodies (functions, DO blocks), which never change the schema here. */
function stripSql(sql: string): string {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Splits on top-level separators, ignoring those inside parentheses or single quotes. */
function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")") depth -= 1;
    else if (!quoted && depth === 0 && char === separator) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** The text inside the parenthesis that opens at `open`. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")" && (depth -= 1) === 0) return text.slice(open + 1, index);
  }
  throw new Error(`Unbalanced parentheses in: ${text.slice(0, 80)}`);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value.toLowerCase());
}

/**
 * Replays CREATE/ALTER/DROP TABLE and TYPE statements from every migration.
 * The result does not depend on file order: a column or enum value that was
 * ever dropped or renamed counts as removed, even if it is added again later.
 */
function replayMigrations(sqlFiles: readonly string[]): SchemaHistory {
  const history: SchemaHistory = {
    columns: new Map(),
    removedColumns: new Map(),
    removedTables: new Set(),
    enumValues: new Map(),
    removedEnumValues: new Map(),
    removedTypes: new Set(),
  };
  const statements = sqlFiles.flatMap((sql) =>
    stripSql(sql)
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  for (const statement of statements) {
    let match: RegExpMatchArray | null;
    if (
      (match = statement.match(
        new RegExp(`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?${NAME} ?\\(`, "i"),
      ))
    ) {
      const table = match[1].toLowerCase();
      if (!history.columns.has(table)) history.columns.set(table, new Set());
      for (const item of splitTopLevel(parenthesized(statement, match[0].length - 1))) {
        if (CONSTRAINT_ITEM.test(item)) continue;
        const column = item.match(/^"?(\w+)"?/);
        if (column) addTo(history.columns, table, column[1]);
      }
    } else if (
      (match = statement.match(
        new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${NAME} (.+)$`, "i"),
      ))
    ) {
      const table = match[1].toLowerCase();
      for (const action of splitTopLevel(match[2])) {
        let part: RegExpMatchArray | null;
        if (/^RENAME TO /i.test(action)) history.removedTables.add(table);
        else if (/^(ADD|DROP|RENAME) CONSTRAINT /i.test(action)) continue;
        else if ((part = action.match(/^RENAME (?:COLUMN )?"?(\w+)"? TO "?(\w+)"?/i))) {
          addTo(history.removedColumns, table, part[1]);
          addTo(history.columns, table, part[2]);
        } else if (/^ADD (?:PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(action)) continue;
        else if ((part = action.match(/^ADD (?:COLUMN )?(?:IF NOT EXISTS )?"?(\w+)"?/i))) {
          addTo(history.columns, table, part[1]);
        } else if ((part = action.match(/^DROP (?:COLUMN )?(?:IF EXISTS )?"?(\w+)"?/i))) {
          addTo(history.removedColumns, table, part[1]);
        }
      }
    } else if ((match = statement.match(/^DROP TABLE (?:IF EXISTS )?(.+)$/i))) {
      for (const name of splitTopLevel(match[1].replace(/ (CASCADE|RESTRICT)$/i, ""))) {
        const table = name.match(new RegExp(`^${NAME}$`));
        if (table) history.removedTables.add(table[1].toLowerCase());
      }
    } else if (
      (match = statement.match(new RegExp(`^CREATE TYPE ${NAME} AS ENUM ?\\((.*)\\)$`, "i")))
    ) {
      for (const value of match[2].matchAll(/'([^']*)'/g)) {
        addTo(history.enumValues, match[1].toLowerCase(), value[1]);
      }
    } else if (
      (match = statement.match(
        new RegExp(`^ALTER TYPE ${NAME} ADD VALUE (?:IF NOT EXISTS )?'([^']*)'`, "i"),
      ))
    ) {
      addTo(history.enumValues, match[1].toLowerCase(), match[2]);
    } else if (
      (match = statement.match(
        new RegExp(`^ALTER TYPE ${NAME} RENAME VALUE '([^']*)' TO '([^']*)'`, "i"),
      ))
    ) {
      addTo(history.removedEnumValues, match[1].toLowerCase(), match[2]);
      addTo(history.enumValues, match[1].toLowerCase(), match[3]);
    } else if ((match = statement.match(new RegExp(`^ALTER TYPE ${NAME} RENAME TO `, "i")))) {
      history.removedTypes.add(match[1].toLowerCase());
    } else if ((match = statement.match(/^DROP TYPE (?:IF EXISTS )?(.+)$/i))) {
      for (const name of splitTopLevel(match[1].replace(/ (CASCADE|RESTRICT)$/i, ""))) {
        const type = name.match(new RegExp(`^${NAME}$`));
        if (type) history.removedTypes.add(type[1].toLowerCase());
      }
    }
  }
  return history;
}

function liveColumns(history: SchemaHistory, table: string): string[] {
  if (history.removedTables.has(table)) return [];
  const removed = history.removedColumns.get(table) ?? new Set();
  return [...(history.columns.get(table) ?? [])].filter((column) => !removed.has(column)).sort();
}

function liveEnumValues(history: SchemaHistory, type: string): string[] {
  if (history.removedTypes.has(type)) return [];
  const removed = history.removedEnumValues.get(type) ?? new Set();
  return [...(history.enumValues.get(type) ?? [])].filter((value) => !removed.has(value)).sort();
}

describe("migration-history replay", () => {
  it("reads column definitions regardless of formatting, quoting and schema prefix", () => {
    const history = replayMigrations([
      `create table if not exists "public"."t"(\n\t"a" uuid primary key,\n  b text check (b in ('x,y', 'z')),\nC int default (1),\n  CONSTRAINT k UNIQUE (a, b)\n);`,
    ]);
    expect(liveColumns(history, "t")).toEqual(["a", "b", "c"]);
  });

  it("applies later ADD, DROP and RENAME COLUMN and table renames from any migration", () => {
    const history = replayMigrations([
      "CREATE TABLE public.t (a int, b int);",
      "ALTER TABLE public.t ADD COLUMN c int, DROP COLUMN b; ALTER TABLE ONLY t RENAME COLUMN a TO z;",
      "CREATE TABLE u (x int); ALTER TABLE u RENAME TO u2;",
    ]);
    expect(liveColumns(history, "t")).toEqual(["c", "z"]);
    expect(liveColumns(history, "u")).toEqual([]);
  });

  it("treats a dropped column as removed even if a later file re-adds it", () => {
    const history = replayMigrations([
      "CREATE TABLE t (a int);",
      "ALTER TABLE t DROP COLUMN a;",
      "ALTER TABLE t ADD COLUMN a int;",
    ]);
    expect(liveColumns(history, "t")).toEqual([]);
  });

  it("ignores constraints, comments and function bodies", () => {
    const history = replayMigrations([
      "CREATE TABLE t (c int);",
      "-- ALTER TABLE t DROP COLUMN c;\n/* ALTER TABLE t DROP COLUMN c; */",
      "ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0); ALTER TABLE t DROP CONSTRAINT k;",
      "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN ALTER TABLE t DROP COLUMN c; END; $fn$ LANGUAGE plpgsql;",
    ]);
    expect(liveColumns(history, "t")).toEqual(["c"]);
  });

  it("applies ALTER TYPE ADD VALUE, RENAME VALUE and DROP TYPE", () => {
    const history = replayMigrations([
      "CREATE TYPE public.s AS ENUM ('a', 'b');",
      "ALTER TYPE s ADD VALUE IF NOT EXISTS 'c' AFTER 'b'; ALTER TYPE public.s RENAME VALUE 'a' TO 'a2';",
      "CREATE TYPE gone AS ENUM ('x'); DROP TYPE IF EXISTS gone CASCADE;",
    ]);
    expect(liveEnumValues(history, "s")).toEqual(["a2", "b", "c"]);
    expect(liveEnumValues(history, "gone")).toEqual([]);
  });

  describe("against this repository's migrations", () => {
    const directories = ["../../supabase/migrations/", "../../drizzle/migrations/"];
    const files = directories.flatMap((directory) => {
      const url = new URL(directory, import.meta.url);
      return readdirSync(url)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => readFileSync(new URL(name, url), "utf8"));
    });
    const history = replayMigrations(files);

    it("finds migrations in both directories", () => {
      for (const directory of directories) {
        const url = new URL(directory, import.meta.url);
        expect(readdirSync(url).some((name) => name.endsWith(".sql"))).toBe(true);
      }
    });

    it("still has every allowlisted source column", () => {
      for (const [table, fields] of Object.entries(SOURCE_FIELDS)) {
        const columns = liveColumns(history, table);
        expect(columns.length).toBeGreaterThan(0);
        expect(columns).toEqual(expect.arrayContaining([...fields]));
      }
    });

    it("partitions the current request_status enum into pending, terminal and excluded statuses", () => {
      const statuses = liveEnumValues(history, "request_status");
      expect(statuses.length).toBeGreaterThan(0);
      expect([...CATALOG_STATUSES].sort()).toEqual(statuses);
      expect(new Set(CATALOG_STATUSES).size).toBe(CATALOG_STATUSES.length);
    });
  });
});

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

describe("module boundaries", () => {
  const importSpecifiers = (source: string) =>
    [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);

  it("imports only deep-freeze.ts", () => {
    expect(importSpecifiers(read("./efficiency-metrics.ts"))).toEqual(["@/lib/deep-freeze"]);
  });

  it("is not imported by F18 modules or deep-freeze.ts", () => {
    for (const file of [
      "./deep-freeze.ts",
      "./time-zones.ts",
      "./reporting-periods.ts",
      "./reporting-period-config.ts",
      "./date-range-filter.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-metrics/);
    }
  });

  it("describes metrics without exporting any calculation functions", () => {
    for (const [name, value] of Object.entries(catalogModule)) {
      expect({ name, type: typeof value }).not.toEqual({ name, type: "function" });
    }
  });
});
