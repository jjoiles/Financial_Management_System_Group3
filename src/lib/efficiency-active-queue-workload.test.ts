import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateActiveQueueWorkload,
  type ActiveQueueWorkloadCalculated,
  type ActiveQueueWorkloadResult,
} from "./efficiency-active-queue-workload";
import { gateMetricLoad } from "./efficiency-classification";
import {
  checkDatasetIntegrity,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type TableReadResult,
} from "./efficiency-data";
import { EFFICIENCY_METRICS, EFFICIENCY_METRICS_VERSION } from "./efficiency-metrics";
import { RECOGNIZED_QUEUE_IDS } from "./efficiency-population";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes
// ---------------------------------------------------------------------------

const CATALOG = EFFICIENCY_METRICS.active_queue_workload;
const T = (value: string) => `2026-${value}+00:00`;

function request(
  id: string,
  status: EfficiencyRequestRow["status"],
  createdAt = T("11-01T00:00:00"),
): EfficiencyRequestRow {
  return { id, status, created_at: createdAt };
}

let stageCounter = 0;
function stage(
  requestId: string,
  queueId: string,
  status = "active",
  overrides: Partial<EfficiencyStageRow> = {},
): EfficiencyStageRow {
  stageCounter += 1;
  return {
    id: `stage-${String(stageCounter).padStart(4, "0")}`,
    request_id: requestId,
    workflow_revision: 1,
    stage_order: stageCounter,
    queue_id: queueId,
    status,
    started_at: T("11-02T00:00:00"),
    completed_at: status === "active" ? null : T("11-03T00:00:00"),
    ...overrides,
  };
}

/** The docs/F19_Efficiency_Metrics.md section 5 dataset (P is a browser prototype). */
function section5() {
  const requests = [
    request("A", "approved", T("11-02T12:58:30")),
    request("B", "rejected", T("11-10T08:59:00")),
    request("C", "approved", T("11-12T10:00:00")),
    request("D", "approved", T("10-30T11:59:00")),
    request("E", "submitted", T("11-25T00:00:00")),
    request("F", "submitted", T("11-14T16:00:00")),
  ];
  const stages = [
    stage("A", "department_budget", "completed", { id: "A1" }),
    stage("A", "dean_office", "completed", { id: "A2" }),
    stage("B", "department_budget", "completed", { id: "B1" }),
    stage("C", "research_admin", "active", { id: "C1" }),
    stage("D", "department_budget", "completed", { id: "D1" }),
    stage("E", "department_budget", "active", { id: "E1" }),
  ];
  const prototypes = [request("P", "submitted", T("11-05T10:00:00"))];
  return { requests, stages, prototypes };
}

/** Section 5.2's second snapshot: R1-R3, R5 with two active stages, R6 in an unknown queue. */
function secondSnapshot() {
  const requests = ["R1", "R2", "R3", "R5", "R6"].map((id) => request(id, "under_review"));
  const stages = [
    stage("R1", "department_budget"),
    stage("R2", "department_budget"),
    stage("R3", "dean_office"),
    stage("R5", "research_admin"),
    stage("R5", "research_admin"),
    stage("R6", "procurement"),
  ];
  return { requests, stages };
}

const WINDOW = {
  readStartedAt: "2026-11-19T08:00:00.000Z",
  readCompletedAt: "2026-11-19T08:00:01.000Z",
};
const STAGE_WINDOW = {
  readStartedAt: "2026-11-19T08:00:01.500Z",
  readCompletedAt: "2026-11-19T08:00:02.000Z",
};
const complete = <Row>(rows: Row[], window = WINDOW): TableReadResult<Row> => ({
  status: "complete",
  rows,
  expectedCount: rows.length,
  pagesRead: 2,
  window,
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
const fieldMissing = <Row>(field: string): TableReadResult<Row> => ({
  status: "field_missing",
  missing: { rowIndex: 0, field },
  pagesRead: 1,
});
const cancelled = <Row>(): TableReadResult<Row> => ({ status: "cancelled", pagesRead: 0 });

const load = (
  requests: TableReadResult<EfficiencyRequestRow>,
  stages: TableReadResult<EfficiencyStageRow>,
): DatasetIntegrityResult => checkDatasetIntegrity({ requests, stages });

const loadOf = (requests: EfficiencyRequestRow[], stages: EfficiencyStageRow[]) =>
  load(complete(requests), complete(stages, STAGE_WINDOW));

function calculated(result: ActiveQueueWorkloadResult): ActiveQueueWorkloadCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}

const workload = (
  requests: EfficiencyRequestRow[],
  stages: EfficiencyStageRow[],
  prototypeRequests?: EfficiencyRequestRow[],
) =>
  calculated(calculateActiveQueueWorkload({ load: loadOf(requests, stages), prototypeRequests }));

const zeroQueues = () => Object.fromEntries(RECOGNIZED_QUEUE_IDS.map((q) => [q, 0]));
const excludedCodes = (result: ActiveQueueWorkloadCalculated) =>
  result.population.excluded.map((e) => [e.record.request_id, e.code]);
const pendingReport = (result: ActiveQueueWorkloadCalculated) =>
  result.separateReports.pending_without_stage;

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (input: unknown) => JSON.parse(JSON.stringify(input));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("Active Queue Workload catalog definition", () => {
  it("is the definition this calculation follows", () => {
    expect(CATALOG.statistic).toBe("distinct-count");
    expect(CATALOG.unit).toBe("requests");
    expect(CATALOG.groupings).toEqual(["queue"]);
    expect(CATALOG.emptyResult).toBe("zero");
    expect(CATALOG.period.mode).toBe("snapshot");
    expect(CATALOG.requiredReads).toEqual(["financial_requests", "approval_stage_tracking"]);
    expect(CATALOG.stageReadCoverage).toBe("all-statuses");
    expect(CATALOG.population.subject).toBe("stage");
    expect(CATALOG.population.conditions.map((c) => c.exclusion)).toEqual([
      "orphaned_active_stage",
    ]);
    expect(CATALOG.flags).toEqual(["duplicate_active_stages", "unknown_queue"]);
    expect(CATALOG.separateReports.map((r) => [r.code, r.population.subject])).toEqual([
      ["pending_without_stage", "request"],
    ]);
    expect(CATALOG.separateReports[0].population.conditions.map((c) => c.exclusion)).toEqual([
      "prototype_request",
    ]);
  });

  it("reports the metric, version and the snapshot's read windows, with no period", () => {
    const { requests, stages } = section5();
    const result = workload(requests, stages);
    expect(result.metricId).toBe("active_queue_workload");
    expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
    expect(result.snapshot).toEqual({
      financial_requests: WINDOW,
      approval_stage_tracking: STAGE_WINDOW,
    });
    expect(result).not.toHaveProperty("period");
    expect(Object.keys(result.population.exclusionCounts)).toEqual(["orphaned_active_stage"]);
    expect(Object.keys(result.population.flagCounts)).toEqual([
      "duplicate_active_stages",
      "unknown_queue",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Workload counts
// ---------------------------------------------------------------------------

describe("Active Queue Workload counts", () => {
  it("reproduces section 5.2's first snapshot", () => {
    const { requests, stages, prototypes } = section5();
    const result = workload(requests, stages, prototypes);
    expect(result.queues).toEqual({ recognized: { ...zeroQueues(), department_budget: 1 } });
    expect(excludedCodes(result)).toEqual([["C", "orphaned_active_stage"]]);
    expect(pendingReport(result).count).toBe(1);
    expect(pendingReport(result).population.exclusionCounts).toEqual({ prototype_request: 1 });
  });

  it("reproduces section 5.2's second snapshot", () => {
    const { requests, stages } = secondSnapshot();
    const result = workload(requests, stages);
    expect(result.queues).toEqual({
      recognized: { ...zeroQueues(), department_budget: 2, dean_office: 1, research_admin: 1 },
      unknown: 1,
    });
    expect(result.population.flagCounts).toEqual({
      duplicate_active_stages: 1,
      unknown_queue: 1,
    });
  });

  it("counts a submitted request with one active stage (1)", () => {
    const result = workload([request("s", "submitted")], [stage("s", "cfo_office")]);
    expect(result.queues.recognized.cfo_office).toBe(1);
  });

  it("counts an under-review request with one active stage (2)", () => {
    const result = workload([request("u", "under_review")], [stage("u", "provost_finance")]);
    expect(result.queues.recognized.provost_finance).toBe(1);
  });

  it("excludes active stages of approved, rejected and completed requests as orphaned (3)", () => {
    const statuses = ["approved", "rejected", "completed"] as const;
    const result = workload(
      statuses.map((s) => request(s, s)),
      statuses.map((s) => stage(s, "dean_office")),
    );
    expect(result.queues).toEqual({ recognized: zeroQueues() });
    expect(excludedCodes(result)).toEqual(statuses.map((s) => [s, "orphaned_active_stage"]));
    expect(result.population.exclusionCounts).toEqual({ orphaned_active_stage: 3 });
  });

  it("counts several active stages of one request in one queue once (4)", () => {
    const result = workload(
      [request("dup", "submitted")],
      [stage("dup", "dean_office"), stage("dup", "dean_office"), stage("dup", "dean_office")],
    );
    expect(result.queues.recognized.dean_office).toBe(1);
    expect(result.counted).toHaveLength(3);
  });

  it("counts a request active in two queues once in each (5)", () => {
    const result = workload(
      [request("both", "under_review")],
      [stage("both", "dean_office"), stage("both", "cfo_office")],
    );
    expect(result.queues.recognized).toEqual({ ...zeroQueues(), dean_office: 1, cfo_office: 1 });
  });

  it("counts different requests in one queue separately (6)", () => {
    const result = workload(
      ["r1", "r2", "r3"].map((id) => request(id, "submitted")),
      ["r1", "r2", "r3", "r2"].map((id) => stage(id, "sponsored_programs")),
    );
    expect(result.queues.recognized.sponsored_programs).toBe(3);
  });

  it("reports every recognized queue in routing order, 0 when empty (7)", () => {
    const result = workload([request("one", "submitted")], [stage("one", "research_admin")]);
    expect(Object.keys(result.queues.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);
    expect(result.queues.recognized).toEqual({ ...zeroQueues(), research_admin: 1 });
  });

  it("counts unknown-queue workload in the unknown group only, and flags it (8)", () => {
    const result = workload(
      [request("x", "submitted"), request("y", "submitted")],
      [stage("x", "procurement"), stage("x", "procurement"), stage("y", "")],
    );
    expect(result.queues).toEqual({ recognized: zeroQueues(), unknown: 2 });
    expect(result.population.flagCounts.unknown_queue).toBe(3);
  });

  it("has no overall value: the catalog groups by queue only, and queues do not sum to requests (13)", () => {
    const result = workload(
      [request("both", "under_review"), request("one", "submitted")],
      [stage("both", "dean_office"), stage("both", "procurement"), stage("one", "dean_office")],
    );
    expect(result).not.toHaveProperty("overall");
    expect(result.queues).toEqual({
      recognized: { ...zeroQueues(), dean_office: 2 },
      unknown: 1,
    });
    // 3 queue entries, but only 2 distinct requests: a sum would double count "both".
    const sum = Object.values(result.queues.recognized).reduce((a, b) => a + b, 0);
    expect(sum + (result.queues.unknown ?? 0)).toBe(3);
    expect(new Set(result.counted.map((s) => s.request_id)).size).toBe(2);
  });

  it("returns 0 for every recognized queue for a complete empty dataset (14)", () => {
    for (const result of [
      workload([], []),
      // Requests and stages, but nothing active.
      workload([request("done", "approved")], [stage("done", "dean_office", "completed")]),
    ]) {
      expect(result.queues).toEqual({ recognized: zeroQueues() });
      expect(result.counted).toEqual([]);
    }
  });

  it("uses no timestamp: active stages count whatever their dates", () => {
    const result = workload(
      [request("odd", "submitted", "garbage")],
      [stage("odd", "dean_office", "active", { started_at: "garbage", completed_at: "garbage" })],
    );
    expect(result.queues.recognized.dean_office).toBe(1);
    expect(result.population.excluded).toEqual([]);
  });

  it("leaves non-active stages out of scope, uncounted anywhere", () => {
    const result = workload(
      [request("p", "submitted")],
      [
        stage("p", "dean_office", "completed"),
        stage("p", "dean_office", "skipped"),
        stage("p", "dean_office", "cancelled"),
        stage("p", "dean_office", "paused"),
        stage("p", "cfo_office", "active"),
      ],
    );
    expect(result.population.inScope).toBe(1);
    expect(result.queues.recognized).toEqual({ ...zeroQueues(), cfo_office: 1 });
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("Active Queue Workload flags", () => {
  it("counts duplicate_active_stages once per request, not per stage (9)", () => {
    const result = workload(
      ["three", "two", "single"].map((id) => request(id, "submitted")),
      [
        stage("three", "dean_office"),
        stage("three", "dean_office"),
        stage("three", "cfo_office"),
        stage("two", "research_admin"),
        stage("two", "research_admin"),
        stage("single", "research_admin"),
      ],
    );
    expect(result.population.flagCounts.duplicate_active_stages).toBe(2);
    // Every stage of a flagged request carries the flag.
    expect(
      result.population.flagged
        .filter((f) => f.flags.includes("duplicate_active_stages"))
        .map((f) => f.record.request_id),
    ).toEqual(["three", "three", "three", "two", "two"]);
  });

  it("keeps duplicated requests in the workload (10)", () => {
    const result = workload(
      [request("three", "submitted")],
      [stage("three", "dean_office"), stage("three", "dean_office"), stage("three", "cfo_office")],
    );
    expect(result.population.excluded).toEqual([]);
    expect(result.counted).toHaveLength(3);
    expect(result.queues.recognized).toEqual({ ...zeroQueues(), dean_office: 1, cfo_office: 1 });
  });

  it("keeps unknown-queue stages in the workload, counted per stage (11)", () => {
    const result = workload(
      [request("x", "submitted")],
      [stage("x", "procurement"), stage("x", "retired")],
    );
    expect(result.population.excluded).toEqual([]);
    expect(result.queues.unknown).toBe(1);
    expect(result.population.flagCounts).toEqual({
      duplicate_active_stages: 1,
      unknown_queue: 2,
    });
    expect(result.population.flagged.map((f) => f.flags)).toEqual([
      ["duplicate_active_stages", "unknown_queue"],
      ["duplicate_active_stages", "unknown_queue"],
    ]);
  });

  it("never flags excluded stages: orphans are excluded before flags apply (12)", () => {
    const result = workload(
      [request("orphan", "approved"), request("pending", "submitted")],
      [
        stage("orphan", "procurement"),
        stage("orphan", "procurement"),
        // One included stage per request: no duplicate after exclusions.
        stage("pending", "dean_office"),
      ],
    );
    expect(excludedCodes(result)).toEqual([
      ["orphan", "orphaned_active_stage"],
      ["orphan", "orphaned_active_stage"],
    ]);
    expect(result.population.flagCounts).toEqual({
      duplicate_active_stages: 0,
      unknown_queue: 0,
    });
    expect(result.population.flagged).toEqual([]);
    expect(result.queues).toEqual({ recognized: { ...zeroQueues(), dean_office: 1 } });
  });
});

// ---------------------------------------------------------------------------
// pending_without_stage
// ---------------------------------------------------------------------------

describe("pending_without_stage separate report", () => {
  const scenario = () => ({
    requests: [
      request("no-stages-submitted", "submitted"),
      request("no-stages-review", "under_review"),
      request("completed-stages", "under_review"),
      request("skipped-cancelled", "submitted"),
      request("active", "submitted"),
      request("decided-no-stages", "approved"),
    ],
    stages: [
      stage("completed-stages", "dean_office", "completed"),
      stage("skipped-cancelled", "dean_office", "skipped"),
      stage("skipped-cancelled", "cfo_office", "cancelled"),
      stage("active", "research_admin"),
    ],
  });

  it("includes pending requests with no stage records of any status (20)", () => {
    const { requests, stages } = scenario();
    const report = pendingReport(workload(requests, stages));
    expect(report.population.included.map((r) => r.id)).toEqual([
      "no-stages-submitted",
      "no-stages-review",
    ]);
    expect(report.count).toBe(2);
    expect(report.population.inScope).toBe(2);
  });

  it("leaves out pending requests that have only completed stages (21)", () => {
    const { requests, stages } = scenario();
    const report = pendingReport(workload(requests, stages));
    expect(report.population.included.map((r) => r.id)).not.toContain("completed-stages");
    // Out of scope, not excluded: it is never counted under any code.
    expect(report.population.excluded).toEqual([]);
  });

  it("leaves out pending requests that have only skipped or cancelled stages (22)", () => {
    const { requests, stages } = scenario();
    const report = pendingReport(workload(requests, stages));
    expect(report.population.included.map((r) => r.id)).not.toContain("skipped-cancelled");
  });

  it("leaves out pending requests with active stages, and decided requests (23)", () => {
    const { requests, stages } = scenario();
    const report = pendingReport(workload(requests, stages));
    expect(report.population.included.map((r) => r.id)).not.toContain("active");
    expect(report.population.included.map((r) => r.id)).not.toContain("decided-no-stages");
  });

  it("excludes owner-scoped prototypes under prototype_request, never in the count", () => {
    const { requests, stages, prototypes } = section5();
    const report = pendingReport(workload(requests, stages, prototypes));
    expect(report.count).toBe(1); // F
    expect(report.population.excluded).toEqual([
      { record: prototypes[0], code: "prototype_request" },
    ]);
    expect(pendingReport(workload(requests, stages)).population.exclusionCounts).toEqual({
      prototype_request: 0,
    });
  });

  it("does not change the workload counts or population (24)", () => {
    const { requests, stages } = scenario();
    const withReport = workload(requests, stages, [request("proto", "submitted")]);
    const withoutStageless = workload(
      requests.filter((r) => !r.id.startsWith("no-stages")),
      stages,
    );
    expect(withReport.queues).toEqual(withoutStageless.queues);
    expect(withReport.population).toEqual(withoutStageless.population);
    expect(withReport.queues).toEqual({ recognized: { ...zeroQueues(), research_admin: 1 } });
    expect(pendingReport(withoutStageless).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Load gating
// ---------------------------------------------------------------------------

describe("Active Queue Workload load gating", () => {
  const { requests, stages } = section5();
  const cases = [
    {
      name: "failed request read (15)",
      loaded: () => load(failed("access"), complete(stages)),
      error: "request_read_failed",
      table: "financial_requests",
      issue: "access",
    },
    {
      name: "incomplete request read (16)",
      loaded: () => load(incomplete(), complete(stages)),
      error: "request_read_incomplete",
      table: "financial_requests",
      issue: null,
    },
    {
      name: "request field missing",
      loaded: () => load(fieldMissing("status"), complete(stages)),
      error: "request_field_missing",
      table: "financial_requests",
      issue: null,
    },
    {
      name: "failed stage read (17)",
      loaded: () => load(complete(requests), failed("unavailable")),
      error: "stage_read_failed",
      table: "approval_stage_tracking",
      issue: "unavailable",
    },
    {
      name: "incomplete stage read (18)",
      loaded: () => load(complete(requests), incomplete()),
      error: "stage_read_incomplete",
      table: "approval_stage_tracking",
      issue: null,
    },
    {
      name: "stage field missing",
      loaded: () => load(complete(requests), fieldMissing("queue_id")),
      error: "stage_field_missing",
      table: "approval_stage_tracking",
      issue: null,
    },
  ] as const;

  for (const { name, loaded, error, table, issue } of cases) {
    it(`blocks on a ${name}`, () => {
      const input = loaded();
      const result = calculateActiveQueueWorkload({ load: input });
      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") return;
      expect(result.errors).toEqual([error]);
      expect(result.incompleteTables).toEqual([table]);
      expect(result.issue?.kind ?? null).toBe(issue);
      expect(result).not.toHaveProperty("queues");
      expect(result).not.toHaveProperty("separateReports");
      expect(result).toEqual(gateMetricLoad("active_queue_workload", input));
    });
  }

  it("blocks on stage_request_not_loaded and when both reads failed", () => {
    expect(
      calculateActiveQueueWorkload({
        load: load(complete(requests.filter((r) => r.id !== "E")), complete(stages)),
      }),
    ).toMatchObject({ status: "blocked", errors: ["stage_request_not_loaded"] });
    expect(
      calculateActiveQueueWorkload({ load: load(failed("access"), incomplete()) }),
    ).toMatchObject({
      status: "blocked",
      errors: ["request_read_failed", "stage_read_incomplete"],
      incompleteTables: ["financial_requests", "approval_stage_tracking"],
    });
  });

  it("stays cancelled when either read was cancelled (19)", () => {
    for (const loaded of [
      load(cancelled(), complete(stages)),
      load(complete(requests), cancelled()),
      load(failed("access"), cancelled()),
    ]) {
      expect(calculateActiveQueueWorkload({ load: loaded })).toEqual({
        status: "cancelled",
        metricId: "active_queue_workload",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Guards and purity
// ---------------------------------------------------------------------------

describe("Active Queue Workload guards and purity", () => {
  it("does not modify its inputs and returns the caller's records in frozen containers (25)", () => {
    const { requests, stages } = secondSnapshot();
    const prototypes = [request("proto", "submitted")];
    const allRequests = [...requests, request("stageless", "submitted")];
    const loaded = loadOf(allRequests, stages);
    const before = snapshot({ loaded, prototypes });

    const result = calculated(
      calculateActiveQueueWorkload({ load: loaded, prototypeRequests: prototypes }),
    );

    expect(snapshot({ loaded, prototypes })).toEqual(before);
    expect(result.counted[0]).toBe(stages[0]);
    expect(pendingReport(result).population.included[0]).toBe(allRequests[5]);
    expect(pendingReport(result).population.excluded[0].record).toBe(prototypes[0]);
    for (const part of [
      result,
      result.snapshot,
      result.queues,
      result.queues.recognized,
      result.counted,
      result.population,
      result.population.flagged,
      result.separateReports,
      pendingReport(result),
      pendingReport(result).population,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it("throws when ids repeat, since a validated F19.3 load cannot contain duplicates", () => {
    const { requests, stages } = secondSnapshot();
    const handBuilt: DatasetIntegrityResult = {
      status: "complete",
      dataset: {
        requests,
        stages: [...stages, { ...stages[2] }],
        consistency: "per-table-validated",
        reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
      },
    };
    expect(() => calculateActiveQueueWorkload({ load: handBuilt })).toThrow(
      new RegExp(`ids repeat \\(${stages[2].id}\\)`),
    );
  });

  it("documents the caller's prototype owner-scoping responsibility", () => {
    const source = readFileSync(
      new URL("./efficiency-active-queue-workload.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/caller MUST scope them\s+\* to the signed-in owner/);
  });

  it("imports only the F19.3 types, shared steps, classification and the catalog", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const source = read("./efficiency-active-queue-workload.ts");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-calculation",
      "@/lib/efficiency-classification",
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
    ]);
    expect(imports[2]).toMatch(/^import type /);
    expect(source).not.toMatch(/supabase|efficiency-data-loader|react|reporting-periods/i);
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-population.ts",
      "./efficiency-classification.ts",
      "./efficiency-calculation.ts",
      "./efficiency-request-volume.ts",
      "./efficiency-stage-processing-time.ts",
      "./efficiency-queue-throughput.ts",
      "./efficiency-decision-metrics.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-active-queue-workload/);
    }
  });
});
