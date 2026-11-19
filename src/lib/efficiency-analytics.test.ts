import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateActiveQueueWorkload } from "./efficiency-active-queue-workload";
import { calculateEfficiencyMetrics, type EfficiencyMetricsReport } from "./efficiency-analytics";
import { gateMetricLoad } from "./efficiency-classification";
import {
  checkDatasetIntegrity,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type TableReadResult,
} from "./efficiency-data";
import {
  calculateApprovalRate,
  calculateRequestTurnaroundTime,
} from "./efficiency-decision-metrics";
import {
  EFFICIENCY_METRICS,
  EFFICIENCY_METRIC_IDS,
  EFFICIENCY_METRICS_VERSION,
  type EfficiencyMetricId,
} from "./efficiency-metrics";
import { RECOGNIZED_QUEUE_IDS } from "./efficiency-population";
import { calculateQueueThroughput } from "./efficiency-queue-throughput";
import { calculateRequestVolume } from "./efficiency-request-volume";
import { calculateStageProcessingTime } from "./efficiency-stage-processing-time";
import { NO_DATA } from "./efficiency-stats";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes, real F18 periods
// ---------------------------------------------------------------------------

function monthPeriod(key: string): PeriodBounds {
  const period = getCalendarMonthPeriod(key);
  if (!period) throw new Error(`no calendar month ${key}`);
  return period;
}

/** November 2026, UTC: [2026-11-01T00:00Z, 2026-12-01T00:00Z). */
const NOVEMBER = monthPeriod("2026-11");
const T = (value: string) => `2026-${value}+00:00`;

function request(
  id: string,
  status: EfficiencyRequestRow["status"],
  createdAt: string,
): EfficiencyRequestRow {
  return { id, status, created_at: createdAt };
}

function stage(
  id: string,
  requestId: string,
  revision: number,
  order: number,
  queueId: string,
  startedAt: string,
  completedAt: string | null,
): EfficiencyStageRow {
  return {
    id,
    request_id: requestId,
    workflow_revision: revision,
    stage_order: order,
    queue_id: queueId,
    status: completedAt === null ? "active" : "completed",
    started_at: startedAt,
    completed_at: completedAt,
  };
}

/** The docs/F19_Efficiency_Metrics.md section 5 dataset, with section 5.3's U1 on request U. */
function section5() {
  const requests = [
    request("A", "approved", T("11-02T12:58:30")),
    request("B", "rejected", T("11-10T08:59:00")),
    request("C", "approved", T("11-12T10:00:00")),
    request("D", "approved", T("10-30T11:59:00")),
    request("E", "submitted", T("11-25T00:00:00")),
    request("F", "submitted", T("11-14T16:00:00")),
    request("U", "approved", T("11-15T00:00:00")),
  ];
  const stages = [
    stage("A1", "A", 1, 1, "department_budget", T("11-02T13:00:00"), T("11-04T13:00:00")),
    stage("A2", "A", 1, 2, "dean_office", T("11-04T13:00:00"), T("11-07T01:00:00")),
    stage("B1", "B", 1, 1, "department_budget", T("11-10T09:00:00"), T("11-10T21:00:00")),
    stage("C1", "C", 1, 1, "research_admin", T("11-12T10:00:20"), null),
    stage("D1", "D", 1, 1, "department_budget", T("10-30T12:00:00"), T("11-01T12:00:00")),
    stage("E1", "E", 1, 1, "department_budget", T("11-25T00:00:10"), null),
    stage("U1", "U", 1, 1, "procurement", T("11-16T00:00:00"), T("11-17T00:00:00")),
  ];
  return { requests, stages };
}

/** Owner-scoped prototypes: one pending (section 5's P) and one decided. */
const prototypes = () => [
  request("P", "submitted", T("11-05T10:00:00")),
  request("P2", "approved", T("11-06T10:00:00")),
];

const WINDOW = {
  readStartedAt: "2026-11-19T08:00:00.000Z",
  readCompletedAt: "2026-11-19T08:00:01.000Z",
};
const complete = <Row>(rows: Row[]): TableReadResult<Row> => ({
  status: "complete",
  rows,
  expectedCount: rows.length,
  pagesRead: 2,
  window: WINDOW,
});
const failed = <Row>(kind: "access" | "unavailable"): TableReadResult<Row> => ({
  status: "failed",
  error: { code: kind === "access" ? "42501" : "503", message: "read failed" },
  issue: { kind, message: `${kind} message` },
  pagesRead: 1,
});
const incomplete = <Row>(): TableReadResult<Row> => ({
  status: "incomplete",
  reason: "count_mismatch",
  counts: { expectedBefore: 3, expectedAfter: 4, collected: 3 },
  pagesRead: 2,
});
const cancelled = <Row>(): TableReadResult<Row> => ({ status: "cancelled", pagesRead: 0 });

const load = (
  requests: TableReadResult<EfficiencyRequestRow>,
  stages: TableReadResult<EfficiencyStageRow>,
): DatasetIntegrityResult => checkDatasetIntegrity({ requests, stages });

const completeLoad = () => {
  const { requests, stages } = section5();
  return load(complete(requests), complete(stages));
};

const REQUEST_METRICS = EFFICIENCY_METRIC_IDS.filter((id) =>
  EFFICIENCY_METRICS[id].requiredReads.includes("financial_requests"),
);
const STAGE_METRICS = EFFICIENCY_METRIC_IDS.filter((id) =>
  EFFICIENCY_METRICS[id].requiredReads.includes("approval_stage_tracking"),
);
const BOTH_READS = EFFICIENCY_METRIC_IDS.filter(
  (id) => REQUEST_METRICS.includes(id) && STAGE_METRICS.includes(id),
);
const PERIOD_METRICS = EFFICIENCY_METRIC_IDS.filter(
  (id) => EFFICIENCY_METRICS[id].period.mode === "period",
);

const statuses = (report: EfficiencyMetricsReport) =>
  Object.fromEntries(EFFICIENCY_METRIC_IDS.map((id) => [id, report.metrics[id].status]));

/** Each metric's own calculator, called directly, for comparison with the entry point. */
function direct(
  loaded: DatasetIntegrityResult,
  period: PeriodBounds,
  prototypeRequests?: readonly EfficiencyRequestRow[],
): Record<EfficiencyMetricId, unknown> {
  const withPrototypes = { load: loaded, period, prototypeRequests };
  return {
    request_volume: calculateRequestVolume(withPrototypes),
    active_queue_workload: calculateActiveQueueWorkload({ load: loaded, prototypeRequests }),
    stage_processing_time_average: calculateStageProcessingTime("stage_processing_time_average", {
      load: loaded,
      period,
    }),
    stage_processing_time_median: calculateStageProcessingTime("stage_processing_time_median", {
      load: loaded,
      period,
    }),
    request_turnaround_time_average: calculateRequestTurnaroundTime(
      "request_turnaround_time_average",
      withPrototypes,
    ),
    request_turnaround_time_median: calculateRequestTurnaroundTime(
      "request_turnaround_time_median",
      withPrototypes,
    ),
    approval_rate: calculateApprovalRate(withPrototypes),
    queue_throughput: calculateQueueThroughput({ load: loaded, period }),
  };
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const snapshot = (input: unknown) => JSON.parse(JSON.stringify(input));
const value = (v: number) => ({ kind: "value", value: v });

// ---------------------------------------------------------------------------
// Catalog coverage
// ---------------------------------------------------------------------------

describe("catalog-to-implementation coverage", () => {
  it("returns exactly one result per catalog metric, in catalog order (1)", () => {
    const report = calculateEfficiencyMetrics({ load: completeLoad(), period: NOVEMBER });
    expect(Object.keys(report.metrics)).toEqual([...EFFICIENCY_METRIC_IDS]);
    expect(Object.values(statuses(report))).toEqual(EFFICIENCY_METRIC_IDS.map(() => "calculated"));
  });

  it("maps every metric id to its own calculator, with an identical result (2, 3, 18)", () => {
    const loaded = completeLoad();
    const report = calculateEfficiencyMetrics({
      load: loaded,
      period: NOVEMBER,
      prototypeRequests: prototypes(),
    });
    const expected = direct(loaded, NOVEMBER, prototypes());
    for (const id of EFFICIENCY_METRIC_IDS) {
      expect(report.metrics[id]).toEqual(expected[id]);
      expect(report.metrics[id].metricId).toBe(id);
    }
  });

  it("has exactly one calculator module per catalog family, and no extra calculators", () => {
    const calculators = readdirSync(new URL(".", import.meta.url))
      .filter((file) => /^efficiency-.*\.ts$/.test(file) && !file.endsWith(".test.ts"))
      .flatMap((file) =>
        [...read(`./${file}`).matchAll(/^export function (calculate\w+)/gm)].map(
          (match) => `${file}:${match[1]}`,
        ),
      )
      .sort();
    expect(calculators).toEqual(
      [
        "efficiency-active-queue-workload.ts:calculateActiveQueueWorkload",
        "efficiency-analytics.ts:calculateEfficiencyMetrics",
        "efficiency-decision-metrics.ts:calculateApprovalRate",
        "efficiency-decision-metrics.ts:calculateRequestTurnaroundTime",
        "efficiency-queue-throughput.ts:calculateQueueThroughput",
        "efficiency-request-volume.ts:calculateRequestVolume",
        "efficiency-stage-processing-time.ts:calculateStageProcessingTime",
      ].sort(),
    );
    // Six catalog families, each with one calculator; average and median share one.
    expect(new Set(EFFICIENCY_METRIC_IDS.map((id) => EFFICIENCY_METRICS[id].family)).size).toBe(6);
  });

  it("stamps every calculated result, and the report, with the catalog version (4)", () => {
    const report = calculateEfficiencyMetrics({ load: completeLoad(), period: NOVEMBER });
    expect(report.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
    for (const id of EFFICIENCY_METRIC_IDS) {
      const result = report.metrics[id];
      if (result.status !== "calculated") throw new Error(`${id} not calculated`);
      expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
    }
  });
});

// ---------------------------------------------------------------------------
// Period and snapshot
// ---------------------------------------------------------------------------

describe("period and snapshot behaviour", () => {
  it("gives every period-assigned metric the same reporting period (5)", () => {
    const report = calculateEfficiencyMetrics({ load: completeLoad(), period: NOVEMBER });
    expect(PERIOD_METRICS).toEqual(
      EFFICIENCY_METRIC_IDS.filter((id) => id !== "active_queue_workload"),
    );
    expect(report.period).toEqual({
      startUtc: NOVEMBER.startUtc,
      endExclusiveUtc: NOVEMBER.endExclusiveUtc,
    });
    for (const id of PERIOD_METRICS) {
      expect(report.metrics[id]).toMatchObject({ status: "calculated", period: report.period });
    }
  });

  it("keeps Active Queue Workload a snapshot: no period, identical in every period (6)", () => {
    expect(EFFICIENCY_METRICS.active_queue_workload.period.mode).toBe("snapshot");
    const loaded = completeLoad();
    const results = ["2026-10", "2026-11", "2027-03"].map(
      (key) =>
        calculateEfficiencyMetrics({ load: loaded, period: monthPeriod(key) }).metrics
          .active_queue_workload,
    );
    for (const result of results) {
      expect(result).toEqual(results[0]);
      expect(result).not.toHaveProperty("period");
    }
    // A different period does change the period metrics.
    const october = calculateEfficiencyMetrics({ load: loaded, period: monthPeriod("2026-10") });
    expect(october.metrics.queue_throughput).toMatchObject({ overall: 0 });
  });

  it("adds no overall Active Queue Workload value (15)", () => {
    const result = calculateEfficiencyMetrics({ load: completeLoad(), period: NOVEMBER }).metrics
      .active_queue_workload;
    expect(EFFICIENCY_METRICS.active_queue_workload.groupings).toEqual(["queue"]);
    if (result.status !== "calculated") throw new Error("not calculated");
    expect(result).not.toHaveProperty("overall");
    expect(Object.keys(result.queues)).toEqual(["recognized"]);
  });

  it("reproduces the section 5 values through the entry point", () => {
    const report = calculateEfficiencyMetrics({
      load: completeLoad(),
      period: NOVEMBER,
      prototypeRequests: [prototypes()[0]],
    });
    const m = report.metrics;
    expect(m.request_volume).toMatchObject({ value: 6 }); // A, B, C, E, F + U
    expect(m.active_queue_workload).toMatchObject({
      queues: { recognized: { department_budget: 1 } },
      separateReports: { pending_without_stage: { count: 1 } },
    });
    expect(m.stage_processing_time_average).toMatchObject({
      overall: { n: 5, value: value(38.4) },
    });
    expect(m.stage_processing_time_median).toMatchObject({ overall: { n: 5, value: value(48) } });
    expect(m.queue_throughput).toMatchObject({ overall: 5, queues: { unknown: 1 } });
    expect(m.approval_rate).toMatchObject({ approved: 3, rejected: 1, value: value(0.75) });
    expect(m.request_turnaround_time_median).toMatchObject({ n: 4 });
  });
});

// ---------------------------------------------------------------------------
// Independent load gating
// ---------------------------------------------------------------------------

describe("independent load gating", () => {
  const { requests, stages } = section5();

  it("blocks only the request-reading metrics on a failed request read (7, 9, 11)", () => {
    const report = calculateEfficiencyMetrics({
      load: load(failed("access"), complete(stages)),
      period: NOVEMBER,
    });
    expect(statuses(report)).toEqual(
      Object.fromEntries(
        EFFICIENCY_METRIC_IDS.map((id) => [
          id,
          REQUEST_METRICS.includes(id) ? "blocked" : "calculated",
        ]),
      ),
    );
    expect(report.metrics.queue_throughput).toMatchObject({ status: "calculated", overall: 5 });
    for (const id of REQUEST_METRICS) {
      expect(report.metrics[id]).toMatchObject({
        status: "blocked",
        errors: ["request_read_failed"],
        issue: { kind: "access" },
      });
    }
  });

  it("blocks only the stage-reading metrics on a failed or incomplete stage read (8, 10, 11)", () => {
    for (const stageRead of [
      failed<EfficiencyStageRow>("unavailable"),
      incomplete<EfficiencyStageRow>(),
    ]) {
      const loaded = load(complete(requests), stageRead);
      const report = calculateEfficiencyMetrics({ load: loaded, period: NOVEMBER });
      expect(statuses(report)).toEqual(
        Object.fromEntries(
          EFFICIENCY_METRIC_IDS.map((id) => [
            id,
            STAGE_METRICS.includes(id) ? "blocked" : "calculated",
          ]),
        ),
      );
      expect(report.metrics.request_volume).toMatchObject({ status: "calculated", value: 6 });
      for (const id of STAGE_METRICS) {
        expect(report.metrics[id]).toEqual(gateMetricLoad(id, loaded));
      }
    }
  });

  it("blocks every metric that needs both reads when either fails, and every metric when both fail (11)", () => {
    expect(BOTH_READS).toEqual([
      "active_queue_workload",
      "stage_processing_time_average",
      "stage_processing_time_median",
      "request_turnaround_time_average",
      "request_turnaround_time_median",
      "approval_rate",
    ]);
    for (const loaded of [
      load(incomplete(), complete(stages)),
      load(complete(requests), failed("access")),
    ]) {
      const report = calculateEfficiencyMetrics({ load: loaded, period: NOVEMBER });
      for (const id of BOTH_READS) expect(report.metrics[id].status).toBe("blocked");
    }
    const both = calculateEfficiencyMetrics({
      load: load(failed("access"), incomplete()),
      period: NOVEMBER,
    });
    expect(new Set(Object.values(statuses(both)))).toEqual(new Set(["blocked"]));
  });

  it("applies stage_request_not_loaded per catalog: blocks every metric that lists it (12)", () => {
    const loaded = load(complete(requests.filter((r) => r.id !== "A")), complete(stages));
    expect(loaded).toMatchObject({ status: "blocked", errors: ["stage_request_not_loaded"] });
    const report = calculateEfficiencyMetrics({ load: loaded, period: NOVEMBER });
    for (const id of EFFICIENCY_METRIC_IDS) {
      const listed = EFFICIENCY_METRICS[id].loadIntegrityErrors.includes(
        "stage_request_not_loaded",
      );
      expect(report.metrics[id].status).toBe(listed ? "blocked" : "calculated");
    }
    expect(report.metrics.request_volume.status).toBe("calculated");
    expect(report.metrics.queue_throughput).toMatchObject({ status: "calculated", overall: 5 });
  });

  it("returns each metric's own cancelled result for a cancelled load (13)", () => {
    for (const loaded of [
      load(cancelled(), complete(stages)),
      load(complete(requests), cancelled()),
    ]) {
      const report = calculateEfficiencyMetrics({ load: loaded, period: NOVEMBER });
      for (const id of EFFICIENCY_METRIC_IDS) {
        expect(report.metrics[id]).toEqual({ status: "cancelled", metricId: id });
      }
    }
  });

  it("never turns a blocked metric into zero or no-data", () => {
    const report = calculateEfficiencyMetrics({
      load: load(failed("unavailable"), failed("unavailable")),
      period: NOVEMBER,
    });
    for (const id of EFFICIENCY_METRIC_IDS) {
      const result = report.metrics[id];
      expect(result.status).toBe("blocked");
      for (const key of ["value", "overall", "queues", "population", "counted"]) {
        expect(result).not.toHaveProperty(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Prototypes, empty loads and purity
// ---------------------------------------------------------------------------

describe("prototypes, empty loads and purity", () => {
  it("passes the caller's prototypes to the request-population metrics only (14)", () => {
    const supplied = prototypes();
    const report = calculateEfficiencyMetrics({
      load: completeLoad(),
      period: NOVEMBER,
      prototypeRequests: supplied,
    });
    const m = report.metrics;
    const prototypeCount = (id: EfficiencyMetricId) => {
      const result = m[id];
      if (result.status !== "calculated") throw new Error(`${id} not calculated`);
      if (id === "active_queue_workload" && "separateReports" in result) {
        return result.separateReports.pending_without_stage.population.exclusionCounts
          .prototype_request;
      }
      return "population" in result
        ? result.population.exclusionCounts.prototype_request
        : undefined;
    };
    expect(Object.fromEntries(EFFICIENCY_METRIC_IDS.map((id) => [id, prototypeCount(id)]))).toEqual(
      {
        request_volume: 2, // P and P2: every request is in scope
        active_queue_workload: 1, // P: pending with no stages
        stage_processing_time_average: undefined, // stage population
        stage_processing_time_median: undefined,
        request_turnaround_time_average: 1, // P2: decided
        request_turnaround_time_median: 1,
        approval_rate: 1,
        queue_throughput: undefined,
      },
    );
    // Excluded prototype records are the caller's own objects; none are added.
    const volume = m.request_volume;
    if (volume.status !== "calculated") throw new Error("not calculated");
    expect(volume.population.excluded.map((e) => e.record)).toEqual(supplied);
    expect(volume.population.excluded[0].record).toBe(supplied[0]);
    // Without prototypes, nothing is counted under prototype_request.
    const none = calculateEfficiencyMetrics({ load: completeLoad(), period: NOVEMBER });
    expect(none.metrics.request_volume).toMatchObject({
      population: { exclusionCounts: { prototype_request: 0 } },
    });
  });

  it("documents the caller's prototype owner-scoping responsibility", () => {
    expect(read("./efficiency-analytics.ts")).toMatch(
      /caller MUST scope them to the\s+\* signed-in owner/,
    );
  });

  it("keeps each metric's zero versus no-data result for an empty complete load (16)", () => {
    const report = calculateEfficiencyMetrics({
      load: load(complete([]), complete([])),
      period: NOVEMBER,
    });
    const m = report.metrics;
    const zeroQueues = Object.fromEntries(RECOGNIZED_QUEUE_IDS.map((q) => [q, 0]));
    expect(m.request_volume).toMatchObject({ value: 0 });
    expect(m.active_queue_workload).toMatchObject({ queues: { recognized: zeroQueues } });
    expect(m.queue_throughput).toMatchObject({ overall: 0, queues: { recognized: zeroQueues } });
    expect(m.stage_processing_time_average).toMatchObject({ overall: { n: 0, value: NO_DATA } });
    expect(m.stage_processing_time_median).toMatchObject({ overall: { n: 0, value: NO_DATA } });
    expect(m.request_turnaround_time_average).toMatchObject({ n: 0, value: NO_DATA });
    expect(m.request_turnaround_time_median).toMatchObject({ n: 0, value: NO_DATA });
    expect(m.approval_rate).toMatchObject({ approved: 0, rejected: 0, value: NO_DATA });
    // Matches the catalog's emptyResult for every metric.
    for (const id of EFFICIENCY_METRIC_IDS) {
      expect(EFFICIENCY_METRICS[id].emptyResult).toBe(
        ["request_volume", "active_queue_workload", "queue_throughput"].includes(id)
          ? "zero"
          : "no-data",
      );
    }
  });

  it("does not modify the load, period or prototypes (17)", () => {
    const loaded = completeLoad();
    const period = { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.endExclusiveUtc };
    const supplied = prototypes();
    const before = snapshot({ loaded, period, supplied });
    const report = calculateEfficiencyMetrics({
      load: loaded,
      period,
      prototypeRequests: supplied,
    });
    expect(snapshot({ loaded, period, supplied })).toEqual(before);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.metrics)).toBe(true);
    expect(Object.isFrozen(report.period)).toBe(true);
    expect(report.period).not.toBe(period);
  });

  it("throws for invalid period bounds, even for a cancelled load", () => {
    const bad = { startUtc: NOVEMBER.endExclusiveUtc, endExclusiveUtc: NOVEMBER.startUtc };
    expect(() => calculateEfficiencyMetrics({ load: completeLoad(), period: bad })).toThrow(
      RangeError,
    );
    expect(() =>
      calculateEfficiencyMetrics({ load: load(cancelled(), cancelled()), period: bad }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

describe("F19 module boundaries", () => {
  /** Each F19 module's layer: a module may import only F19 modules from lower layers. */
  const LAYERS: Record<string, number> = {
    "efficiency-metrics": 0,
    "efficiency-data": 1,
    "efficiency-stats": 1,
    "efficiency-data-loader": 2,
    "efficiency-population": 2,
    "efficiency-classification": 3,
    "efficiency-calculation": 4,
    "efficiency-request-volume": 5,
    "efficiency-stage-processing-time": 5,
    "efficiency-queue-throughput": 5,
    "efficiency-decision-metrics": 5,
    "efficiency-active-queue-workload": 5,
    "efficiency-analytics": 6,
  };
  const importsOf = (module: string) =>
    [...read(`./${module}.ts`).matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);

  it("lists every F19 module", () => {
    const modules = readdirSync(new URL(".", import.meta.url))
      .filter((file) => /^efficiency-.*\.ts$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => file.replace(/\.ts$/, ""))
      .sort();
    expect(modules).toEqual(Object.keys(LAYERS).sort());
  });

  it("imports only downward, so there are no cycles and calculators do not import each other", () => {
    for (const [module, layer] of Object.entries(LAYERS)) {
      for (const target of importsOf(module)) {
        const name = target.replace(/^@\/lib\//, "").replace(/^\.\//, "");
        if (name in LAYERS) {
          expect(`${module} -> ${name}: ${LAYERS[name] < layer}`).toBe(
            `${module} -> ${name}: true`,
          );
        }
      }
    }
  });

  it("makes the entry point import only the calculators, the catalog and types", () => {
    expect(importsOf("efficiency-analytics")).toEqual([
      "@/lib/efficiency-active-queue-workload",
      "@/lib/efficiency-data",
      "@/lib/efficiency-decision-metrics",
      "@/lib/efficiency-metrics",
      "@/lib/efficiency-queue-throughput",
      "@/lib/efficiency-request-volume",
      "@/lib/efficiency-stage-processing-time",
      "@/lib/time-zones",
    ]);
    const source = read("./efficiency-analytics.ts");
    expect(source).toMatch(/^import type \{ DatasetIntegrityResult/m);
    expect(source).toMatch(/^import type \{ PeriodBounds/m);
    // No calculation of its own: no gate, classification, statistics or period test.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(
      /gateMetricLoad|classifyMetricPopulation|classifyRecords|isWithinPeriod|hoursBetween|\baverage\(|\bmedian\(|supabase|react/i,
    );
  });

  it("exports only the entry point and its types", () => {
    const source = read("./efficiency-analytics.ts");
    expect([...source.matchAll(/^export (\w+) (\w+)/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "type EfficiencyMetricsInput",
      "type EfficiencyMetricResults",
      "type EfficiencyMetricsReport",
      "function calculateEfficiencyMetrics",
    ]);
  });

  it("is not imported by any module outside its tests", () => {
    for (const module of Object.keys(LAYERS).filter((m) => m !== "efficiency-analytics")) {
      expect(read(`./${module}.ts`)).not.toMatch(/efficiency-analytics/);
    }
  });
});
