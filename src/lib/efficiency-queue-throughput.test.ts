import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
import {
  calculateQueueThroughput,
  type QueueThroughputCalculated,
  type QueueThroughputResult,
} from "./efficiency-queue-throughput";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes, real F18 periods
// ---------------------------------------------------------------------------

const CATALOG = EFFICIENCY_METRICS.queue_throughput;

function monthPeriod(key: string): PeriodBounds {
  const period = getCalendarMonthPeriod(key);
  if (!period) throw new Error(`no calendar month ${key}`);
  return period;
}

/** November 2026, UTC: [2026-11-01T00:00Z, 2026-12-01T00:00Z). */
const NOVEMBER = monthPeriod("2026-11");
const OCTOBER = monthPeriod("2026-10");
const DECEMBER = monthPeriod("2026-12");

const T = (value: string) => `2026-${value}+00:00`;

function request(
  id: string,
  status: EfficiencyRequestRow["status"],
  createdAt = T("11-01T00:00:00"),
): EfficiencyRequestRow {
  return { id, status, created_at: createdAt };
}

function stage(
  id: string,
  requestId: string,
  queueId: string,
  startedAt: string | null,
  completedAt: string | null,
  overrides: Partial<EfficiencyStageRow> = {},
): EfficiencyStageRow {
  return {
    id,
    request_id: requestId,
    workflow_revision: 1,
    stage_order: 1,
    queue_id: queueId,
    status: completedAt === null ? "active" : "completed",
    started_at: startedAt as string,
    completed_at: completedAt,
    ...overrides,
  };
}

/** The docs/F19_Efficiency_Metrics.md section 5 dataset (F and P have no stages). */
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
    stage("A1", "A", "department_budget", T("11-02T13:00:00"), T("11-04T13:00:00")),
    stage("A2", "A", "dean_office", T("11-04T13:00:00"), T("11-07T01:00:00"), { stage_order: 2 }),
    stage("B1", "B", "department_budget", T("11-10T09:00:00"), T("11-10T21:00:00")),
    stage("C1", "C", "research_admin", T("11-12T10:00:20"), null),
    stage("D1", "D", "department_budget", T("10-30T12:00:00"), T("11-01T12:00:00")),
    stage("E1", "E", "department_budget", T("11-25T00:00:10"), null),
  ];
  return { requests, stages };
}

/** Section 5.3's unknown-queue stage U1: procurement, completed in November. */
const U1 = () => stage("U1", "U", "procurement", T("11-16T00:00:00"), T("11-17T00:00:00"));

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
  load(complete(requests), complete(stages));

function calculated(result: QueueThroughputResult): QueueThroughputCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}

const throughput = (
  requests: EfficiencyRequestRow[],
  stages: EfficiencyStageRow[],
  period: PeriodBounds = NOVEMBER,
) => calculated(calculateQueueThroughput({ load: loadOf(requests, stages), period }));

/** Throughput from the stage read alone, with the request read failed. */
const stageOnly = (stages: EfficiencyStageRow[], period: PeriodBounds = NOVEMBER) =>
  calculated(
    calculateQueueThroughput({ load: load(failed("unavailable"), complete(stages)), period }),
  );

const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);
const excludedCodes = (result: QueueThroughputCalculated) =>
  result.population.excluded.map((e) => [e.record.id, e.code]);
const zeroQueues = () => Object.fromEntries(RECOGNIZED_QUEUE_IDS.map((q) => [q, 0]));
const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (input: unknown) => JSON.parse(JSON.stringify(input));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("Queue Throughput catalog definition", () => {
  it("is the definition this calculation follows", () => {
    expect(CATALOG.statistic).toBe("count");
    expect(CATALOG.unit).toBe("stage-decisions");
    expect(CATALOG.emptyResult).toBe("zero");
    expect(CATALOG.groupings).toEqual(["overall", "queue"]);
    expect(CATALOG.requiredReads).toEqual(["approval_stage_tracking"]);
    expect(CATALOG.loadIntegrityErrors).toEqual([
      "stage_read_failed",
      "stage_read_incomplete",
      "stage_field_missing",
    ]);
    expect(CATALOG.period).toMatchObject({
      mode: "period",
      anchor: { table: "approval_stage_tracking", field: "completed_at" },
    });
    expect(CATALOG.population.subject).toBe("stage");
    expect(CATALOG.population.conditions.map((c) => c.exclusion)).toEqual([
      "skipped_or_cancelled_stage",
      "unrecognized_stage_status",
      "stage_missing_completed_at",
      "invalid_stage_timestamps",
    ]);
    expect(CATALOG.flags).toEqual(["unknown_queue"]);
  });

  it("reports the metric, catalog version, period and exclusion counts in catalog order", () => {
    const { requests, stages } = section5();
    const result = throughput(requests, stages);
    expect(result.metricId).toBe("queue_throughput");
    expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
    expect(result.period).toEqual({
      startUtc: NOVEMBER.startUtc,
      endExclusiveUtc: NOVEMBER.endExclusiveUtc,
    });
    expect(Object.keys(result.population.exclusionCounts)).toEqual(
      CATALOG.population.conditions.map((c) => c.exclusion),
    );
  });
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

describe("Queue Throughput counting", () => {
  it("reproduces section 5.6: 4 stage decisions from 3 requests (1, 3)", () => {
    const { requests, stages } = section5();
    const result = throughput(requests, stages);
    expect(result.overall).toBe(4);
    expect(result.queues.recognized).toEqual({
      ...zeroQueues(),
      department_budget: 3,
      dean_office: 1,
    });
    expect(ids(result.counted)).toEqual(["A1", "A2", "B1", "D1"]);
    // Stage decisions, not distinct requests.
    expect(new Set(result.counted.map((s) => s.request_id)).size).toBe(3);
  });

  it("counts several completed stages of one request separately, even in one queue (2)", () => {
    // Request H: revision 1 completed at department_budget, then amended and
    // completed again at department_budget in revision 2.
    const result = throughput(
      [request("H", "approved")],
      [
        stage("H-r1", "H", "department_budget", T("11-02T00:00:00"), T("11-02T10:00:00")),
        stage("H-r2", "H", "department_budget", T("11-04T00:00:00"), T("11-04T05:00:00"), {
          workflow_revision: 2,
        }),
      ],
    );
    expect(result.queues.recognized.department_budget).toBe(2);
    expect(result.overall).toBe(2);
  });

  it("counts recognized queues and the unknown group, which appears only when populated (4)", () => {
    const { requests, stages } = section5();
    const without = throughput(requests, stages);
    expect(without.queues).not.toHaveProperty("unknown");
    expect(Object.keys(without.queues.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);

    const withU1 = throughput([...requests, request("U", "approved")], [...stages, U1()]);
    expect(withU1.queues.unknown).toBe(1);
    expect(withU1.overall).toBe(5);
    expect(withU1.queues.recognized).toEqual(without.queues.recognized);
  });

  it("makes the overall total the sum of every queue group (5)", () => {
    const { requests, stages } = section5();
    const result = throughput([...requests, request("U", "approved")], [...stages, U1()]);
    const groups = [...Object.values(result.queues.recognized), result.queues.unknown ?? 0];
    expect(result.overall).toBe(sum(groups));
    expect(result.overall).toBe(result.counted.length);
  });

  it("returns the number 0 overall and for every recognized queue when empty (6)", () => {
    for (const result of [
      throughput([], []),
      throughput(section5().requests, section5().stages, monthPeriod("2027-03")),
      throughput(
        [request("E", "submitted")],
        [stage("E1", "E", "dean_office", T("11-02T00:00:00"), null)],
      ),
    ]) {
      expect(result.overall).toBe(0);
      expect(result.queues).toEqual({ recognized: zeroQueues() });
    }
  });

  it("counts rejections and completed-status requests' stages", () => {
    const result = throughput(
      [request("B", "rejected"), request("G", "completed")],
      [
        stage("B1", "B", "department_budget", T("11-10T09:00:00"), T("11-10T21:00:00")),
        stage("G1", "G", "dean_office", T("11-10T00:00:00"), T("11-11T00:00:00")),
      ],
    );
    expect(ids(result.counted)).toEqual(["B1", "G1"]);
  });
});

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

describe("Queue Throughput period filtering", () => {
  it("includes a stage completed exactly at the period start (7)", () => {
    const result = stageOnly([
      stage("start", "r", "dean_office", T("10-31T00:00:00"), NOVEMBER.startUtc),
    ]);
    expect(result.queues.recognized.dean_office).toBe(1);
  });

  it("excludes a stage completed exactly at the period end; it counts in December (8)", () => {
    const stages = [
      stage("last", "r1", "dean_office", T("11-30T00:00:00"), "2026-11-30T23:59:59.999Z"),
      stage("end", "r2", "dean_office", T("11-30T00:00:00"), NOVEMBER.endExclusiveUtc),
    ];
    expect(ids(stageOnly(stages, NOVEMBER).counted)).toEqual(["last"]);
    expect(ids(stageOnly(stages, DECEMBER).counted)).toEqual(["end"]);
  });

  it("counts a stage started before the period in the period it completed", () => {
    const { requests, stages } = section5();
    expect(ids(throughput(requests, stages, NOVEMBER).counted)).toContain("D1");
    expect(throughput(requests, stages, OCTOBER).overall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("Queue Throughput exclusions", () => {
  it("applies the four conditions and leaves active stages out of scope (9)", () => {
    const stages = [
      stage("good", "r", "dean_office", T("11-02T00:00:00"), T("11-02T06:00:00")),
      stage("skipped", "r", "dean_office", null, null, { status: "skipped" }),
      stage("cancelled", "r", "dean_office", T("11-02T00:00:00"), null, { status: "cancelled" }),
      stage("paused", "r", "dean_office", T("11-02T00:00:00"), T("11-02T01:00:00"), {
        status: "paused",
      }),
      stage("null-status", "r", "dean_office", T("11-02T00:00:00"), T("11-02T01:00:00"), {
        status: null as unknown as string,
      }),
      stage("no-completed", "r", "dean_office", T("11-02T00:00:00"), null, {
        status: "completed",
      }),
      stage("reversed", "r", "dean_office", T("11-03T00:00:00"), T("11-02T00:00:00")),
      stage("bad-start", "r", "dean_office", "2026-11-02", T("11-02T01:00:00")),
      stage("active", "r", "dean_office", T("11-02T00:00:00"), null),
    ];
    const result = stageOnly(stages);
    expect(ids(result.counted)).toEqual(["good"]);
    expect(excludedCodes(result)).toEqual([
      ["skipped", "skipped_or_cancelled_stage"],
      ["cancelled", "skipped_or_cancelled_stage"],
      ["paused", "unrecognized_stage_status"],
      ["null-status", "unrecognized_stage_status"],
      ["no-completed", "stage_missing_completed_at"],
      ["reversed", "invalid_stage_timestamps"],
      ["bad-start", "invalid_stage_timestamps"],
    ]);
    expect(result.population.exclusionCounts).toEqual({
      skipped_or_cancelled_stage: 2,
      unrecognized_stage_status: 2,
      stage_missing_completed_at: 1,
      invalid_stage_timestamps: 2,
    });
    // The active stage is outside the scope: neither included nor counted.
    expect(result.population.inScope).toBe(stages.length - 1);
    expect(result.population.exclusionCounts).not.toHaveProperty("in_progress_stage");
  });

  it("gives a stage failing several conditions only the earliest one (9, precedence)", () => {
    const result = stageOnly([
      stage("cancelled+invalid", "r", "dean_office", "garbage", null, { status: "cancelled" }),
      stage("paused+invalid", "r", "dean_office", "garbage", null, { status: "paused" }),
      stage("missing+invalid", "r", "dean_office", "garbage", null, { status: "completed" }),
    ]);
    expect(excludedCodes(result)).toEqual([
      ["cancelled+invalid", "skipped_or_cancelled_stage"],
      ["paused+invalid", "unrecognized_stage_status"],
      ["missing+invalid", "stage_missing_completed_at"],
    ]);
    expect(result.population.exclusionCounts.invalid_stage_timestamps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flags and data-quality counts
// ---------------------------------------------------------------------------

describe("Queue Throughput flags and data-quality counts", () => {
  it("flags unknown-queue stages without excluding them (10)", () => {
    const result = stageOnly([
      U1(),
      stage("U2", "U", "procurement", null, null, { status: "skipped" }),
      stage("U3", "U", "", T("11-18T00:00:00"), T("11-18T01:00:00")),
    ]);
    expect(result.population.flagCounts).toEqual({ unknown_queue: 2 });
    expect(result.population.flagged.map((f) => [f.record.id, f.flags])).toEqual([
      ["U1", ["unknown_queue"]],
      ["U3", ["unknown_queue"]],
    ]);
    expect(result.queues.unknown).toBe(2);
    expect(result.overall).toBe(2);
    expect(excludedCodes(result)).toEqual([["U2", "skipped_or_cancelled_stage"]]);
  });

  it("counts data quality over the whole dataset, whatever the period (11)", () => {
    const stages = [
      stage("oct", "r", "dean_office", T("10-02T00:00:00"), T("10-03T00:00:00")),
      stage("nov", "r", "dean_office", T("11-02T00:00:00"), T("11-03T00:00:00")),
      stage("dec", "r", "procurement", T("12-02T00:00:00"), T("12-03T00:00:00")),
      stage("skipped", "r", "dean_office", null, null, { status: "skipped" }),
      stage("bad", "r", "dean_office", "garbage", T("11-03T00:00:00")),
    ];
    const results = [OCTOBER, NOVEMBER, DECEMBER, monthPeriod("2027-03")].map((p) =>
      stageOnly(stages, p),
    );
    expect(results.map((r) => r.overall)).toEqual([1, 1, 1, 0]);
    for (const result of results) {
      expect(result.population).toEqual(results[0].population);
    }
    expect(results[0].population.exclusionCounts).toEqual({
      skipped_or_cancelled_stage: 1,
      unrecognized_stage_status: 0,
      stage_missing_completed_at: 0,
      invalid_stage_timestamps: 1,
    });
    expect(results[0].population.flagCounts).toEqual({ unknown_queue: 1 });
  });
});

// ---------------------------------------------------------------------------
// Load gating
// ---------------------------------------------------------------------------

describe("Queue Throughput load gating", () => {
  const { requests, stages } = section5();

  it("blocks on a failed, incomplete or field-missing stage read (12)", () => {
    const cases = [
      { read: failed<EfficiencyStageRow>("access"), error: "stage_read_failed", issue: "access" },
      { read: incomplete<EfficiencyStageRow>(), error: "stage_read_incomplete", issue: null },
      {
        read: fieldMissing<EfficiencyStageRow>("completed_at"),
        error: "stage_field_missing",
        issue: null,
      },
    ] as const;
    for (const { read, error, issue } of cases) {
      const loaded = load(complete(requests), read);
      const result = calculateQueueThroughput({ load: loaded, period: NOVEMBER });
      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") continue;
      expect(result.errors).toEqual([error]);
      expect(result.incompleteTables).toEqual(["approval_stage_tracking"]);
      expect(result.issue?.kind ?? null).toBe(issue);
      expect(result).not.toHaveProperty("overall");
      expect(result).toEqual(gateMetricLoad("queue_throughput", loaded));
    }
  });

  it("calculates when the request read failed, was incomplete or missed a field (13)", () => {
    for (const read of [
      failed<EfficiencyRequestRow>("access"),
      failed<EfficiencyRequestRow>("unavailable"),
      incomplete<EfficiencyRequestRow>(),
      fieldMissing<EfficiencyRequestRow>("created_at"),
    ]) {
      const loaded = load(read, complete(stages));
      expect(loaded.status).toBe("blocked");
      const result = calculated(calculateQueueThroughput({ load: loaded, period: NOVEMBER }));
      expect(result.overall).toBe(4);
      expect(result).toEqual(throughput(requests, stages));
    }
  });

  it("calculates despite stage_request_not_loaded, counting stages whose request is missing (14)", () => {
    expect(CATALOG.loadIntegrityErrors).not.toContain("stage_request_not_loaded");
    const loaded = load(complete(requests.filter((r) => r.id !== "A")), complete(stages));
    expect(loaded).toMatchObject({ status: "blocked", errors: ["stage_request_not_loaded"] });
    const result = calculated(calculateQueueThroughput({ load: loaded, period: NOVEMBER }));
    expect(ids(result.counted)).toEqual(["A1", "A2", "B1", "D1"]);
  });

  it("stays cancelled when either read was cancelled (15)", () => {
    for (const loaded of [
      load(cancelled(), complete(stages)),
      load(complete(requests), cancelled()),
      load(failed("access"), cancelled()),
    ]) {
      expect(calculateQueueThroughput({ load: loaded, period: NOVEMBER })).toEqual({
        status: "cancelled",
        metricId: "queue_throughput",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Guards and purity
// ---------------------------------------------------------------------------

describe("Queue Throughput guards and purity", () => {
  it("does not modify its inputs and returns the caller's records in frozen containers (16)", () => {
    const { requests, stages } = section5();
    const allRequests = [...requests, request("U", "approved")];
    const allStages = [...stages, U1()];
    const loaded = loadOf(allRequests, allStages);
    const period = { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.endExclusiveUtc };
    const before = snapshot({ loaded, period });

    const result = calculated(calculateQueueThroughput({ load: loaded, period }));

    expect(snapshot({ loaded, period })).toEqual(before);
    expect(result.counted[0]).toBe(allStages[0]);
    expect(result.population.flagged[0].record).toBe(allStages[6]);
    for (const part of [
      result,
      result.queues,
      result.queues.recognized,
      result.counted,
      result.period,
      result.population,
      result.population.included,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it("throws for invalid period bounds instead of returning 0", () => {
    const { requests, stages } = section5();
    for (const period of [
      { startUtc: NOVEMBER.startUtc, endExclusiveUtc: "2026-12-01" },
      { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.startUtc },
    ]) {
      expect(() => calculateQueueThroughput({ load: loadOf(requests, stages), period })).toThrow(
        RangeError,
      );
    }
  });

  it("throws when stage ids repeat, since a validated F19.3 load cannot contain duplicates", () => {
    const { stages } = section5();
    const handBuilt: DatasetIntegrityResult = {
      status: "blocked",
      errors: ["request_read_failed"],
      issue: { kind: "unavailable", message: "down" },
      completeTables: {
        financial_requests: null,
        approval_stage_tracking: { rows: [...stages, { ...stages[1] }], window: WINDOW },
      },
    };
    expect(() => calculateQueueThroughput({ load: handBuilt, period: NOVEMBER })).toThrow(/A2/);
  });

  it("imports only the F19.3 types, shared steps, classification, the catalog and F18 types", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const source = read("./efficiency-queue-throughput.ts");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-calculation",
      "@/lib/efficiency-classification",
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
      "@/lib/time-zones",
    ]);
    expect(imports[2]).toMatch(/^import type /);
    expect(source).not.toMatch(/supabase|efficiency-data-loader|react/i);
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-population.ts",
      "./efficiency-classification.ts",
      "./efficiency-calculation.ts",
      "./efficiency-request-volume.ts",
      "./efficiency-stage-processing-time.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-queue-throughput/);
    }
  });
});
