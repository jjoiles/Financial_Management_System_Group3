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
  calculateStageProcessingTime,
  type StageProcessingTimeCalculated,
  type StageProcessingTimeMetricId,
  type StageProcessingTimeResult,
} from "./efficiency-stage-processing-time";
import { NO_DATA } from "./efficiency-stats";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes, real F18 periods
// ---------------------------------------------------------------------------

const AVERAGE = "stage_processing_time_average";
const MEDIAN = "stage_processing_time_median";
const BOTH: StageProcessingTimeMetricId[] = [AVERAGE, MEDIAN];

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

/** Section 5.3's unknown-queue stage U1: procurement, 24 h, in November. */
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

function calculated(result: StageProcessingTimeResult): StageProcessingTimeCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}

const spt = (
  metricId: StageProcessingTimeMetricId,
  requests: EfficiencyRequestRow[],
  stages: EfficiencyStageRow[],
  period: PeriodBounds = NOVEMBER,
) => calculated(calculateStageProcessingTime(metricId, { load: loadOf(requests, stages), period }));

/** A request plus stages owned by it, for small focused datasets. */
const owned = (
  stages: EfficiencyStageRow[],
  status: EfficiencyRequestRow["status"] = "approved",
) => {
  const requestIds = [...new Set(stages.map((s) => s.request_id))];
  return { requests: requestIds.map((id) => request(id, status)), stages };
};

const value = (v: number) => ({ kind: "value", value: v });
const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);
const excludedCodes = (result: StageProcessingTimeCalculated) =>
  result.population.excluded.map((e) => [e.record.id, e.code]);

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (input: unknown) => JSON.parse(JSON.stringify(input));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("Stage Processing Time catalog definition", () => {
  it("is the definition this calculation follows", () => {
    for (const id of BOTH) {
      const metric = EFFICIENCY_METRICS[id];
      expect(metric.family).toBe("stage_processing_time");
      expect(metric.emptyResult).toBe("no-data");
      expect(metric.groupings).toEqual(["overall", "queue"]);
      expect(metric.requiredReads).toEqual(["financial_requests", "approval_stage_tracking"]);
      expect(metric.period).toMatchObject({
        mode: "period",
        anchor: { table: "approval_stage_tracking", field: "completed_at" },
      });
      expect(metric.population.subject).toBe("stage");
      expect(metric.population.conditions.map((c) => c.exclusion)).toEqual([
        "orphaned_active_stage",
        "in_progress_stage",
        "skipped_or_cancelled_stage",
        "unrecognized_stage_status",
        "stage_missing_completed_at",
        "invalid_stage_timestamps",
      ]);
      expect(metric.flags).toEqual(["unknown_queue"]);
    }
    expect(EFFICIENCY_METRICS[AVERAGE].statistic).toBe("average");
    expect(EFFICIENCY_METRICS[MEDIAN].statistic).toBe("median");
  });

  it("reports the metric, its catalog statistic, version and period", () => {
    const { requests, stages } = section5();
    for (const id of BOTH) {
      const result = spt(id, requests, stages);
      expect(result.metricId).toBe(id);
      expect(result.statistic).toBe(EFFICIENCY_METRICS[id].statistic);
      expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
      expect(result.period).toEqual({
        startUtc: NOVEMBER.startUtc,
        endExclusiveUtc: NOVEMBER.endExclusiveUtc,
      });
      expect(Object.keys(result.population.exclusionCounts)).toEqual(
        EFFICIENCY_METRICS[id].population.conditions.map((c) => c.exclusion),
      );
    }
  });

  it("rejects a metric id outside the stage processing family", () => {
    const { requests, stages } = section5();
    expect(() =>
      calculateStageProcessingTime("queue_throughput" as StageProcessingTimeMetricId, {
        load: loadOf(requests, stages),
        period: NOVEMBER,
      }),
    ).toThrow(/not a stage processing time metric/);
  });
});

// ---------------------------------------------------------------------------
// Durations and statistics
// ---------------------------------------------------------------------------

describe("Stage Processing Time durations and statistics", () => {
  it("measures (completed_at - started_at) / 3,600,000 ms at full precision (1)", () => {
    const data = owned([
      stage("s1", "r1", "department_budget", T("11-02T13:00:00"), T("11-04T13:00:00")),
      stage("s2", "r2", "dean_office", T("11-05T13:00:00"), T("11-05T13:01:30")),
      stage("s3", "r3", "cfo_office", "2026-11-06T08:00:00-05:00", "2026-11-06T13:00:00.001Z"),
    ]);
    const result = spt(AVERAGE, data.requests, data.stages);
    expect(result.queues.recognized.department_budget.value).toEqual(value(48));
    expect(result.queues.recognized.dean_office.value).toEqual(value(0.025));
    // Offsets are honoured: 08:00-05:00 is 13:00Z, so 1 ms elapsed.
    expect(result.queues.recognized.cfo_office.value).toEqual(value(1 / 3_600_000));
  });

  it("reproduces section 5.3: average and median per queue and pooled overall (2)", () => {
    const { requests, stages } = section5();
    const avg = spt(AVERAGE, requests, stages);
    const med = spt(MEDIAN, requests, stages);

    expect(avg.queues.recognized.department_budget).toEqual({ n: 3, value: value(36) });
    expect(med.queues.recognized.department_budget).toEqual({ n: 3, value: value(48) }); // odd n
    expect(avg.queues.recognized.dean_office).toEqual({ n: 1, value: value(60) });
    expect(med.queues.recognized.dean_office).toEqual({ n: 1, value: value(60) });
    expect(avg.overall).toEqual({ n: 4, value: value(42) });
    expect(med.overall).toEqual({ n: 4, value: value(48) }); // even n: (48 + 48) / 2
    // Pooled, never the average of the queue averages ((36 + 60) / 2 = 48).
    expect(avg.overall.value).not.toEqual(value(48));
    expect(ids(avg.counted)).toEqual(["A1", "A2", "B1", "D1"]);
  });

  it("takes the mean of the two middle values for an even count", () => {
    const data = owned(
      [1, 2, 3, 10].map((h, i) =>
        stage(
          `s${i}`,
          `r${i}`,
          "research_admin",
          T("11-10T00:00:00"),
          T(`11-10T${String(h).padStart(2, "0")}:00:00`),
        ),
      ),
    );
    expect(spt(MEDIAN, data.requests, data.stages).overall).toEqual({ n: 4, value: value(2.5) });
    expect(spt(AVERAGE, data.requests, data.stages).overall).toEqual({ n: 4, value: value(4) });
  });

  it("pools unknown-queue stages into the overall value and its own group (3)", () => {
    const { requests, stages } = section5();
    const data = { requests: [...requests, request("U", "approved")], stages: [...stages, U1()] };
    const avg = spt(AVERAGE, data.requests, data.stages);
    const med = spt(MEDIAN, data.requests, data.stages);
    expect(avg.overall).toEqual({ n: 5, value: value(38.4) });
    expect(med.overall).toEqual({ n: 5, value: value(48) });
    expect(avg.queues.unknown).toEqual({ n: 1, value: value(24) });
    // Recognized queues are unchanged by the unknown stage.
    expect(avg.queues.recognized).toEqual(spt(AVERAGE, requests, stages).queues.recognized);
  });

  it("returns every recognized queue in routing order and the unknown group only when populated (4)", () => {
    const { requests, stages } = section5();
    const result = spt(AVERAGE, requests, stages);
    expect(Object.keys(result.queues.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);
    expect(result.queues).not.toHaveProperty("unknown");
    for (const queueId of [
      "research_admin",
      "provost_finance",
      "sponsored_programs",
      "cfo_office",
    ] as const) {
      expect(result.queues.recognized[queueId]).toEqual({ n: 0, value: NO_DATA });
    }
    // C1 is research_admin but orphaned, so research_admin has no value.
    expect(result.population.excluded.map((e) => e.record.queue_id)).toContain("research_admin");
  });

  it("returns no-data, never 0, for an empty population (5)", () => {
    for (const id of BOTH) {
      const empty = spt(id, [], []);
      expect(empty.overall).toEqual({ n: 0, value: NO_DATA });
      for (const queueId of RECOGNIZED_QUEUE_IDS) {
        expect(empty.queues.recognized[queueId]).toEqual({ n: 0, value: NO_DATA });
      }
      expect(empty.queues).not.toHaveProperty("unknown");
      // Stages exist but none completed in the period.
      const { requests, stages } = section5();
      expect(spt(id, requests, stages, monthPeriod("2027-03")).overall).toEqual({
        n: 0,
        value: NO_DATA,
      });
      // Every stage excluded.
      const onlyActive = owned(
        [stage("x", "r", "dean_office", T("11-02T00:00:00"), null)],
        "submitted",
      );
      expect(spt(id, onlyActive.requests, onlyActive.stages).overall.value).toEqual(NO_DATA);
    }
  });
});

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

describe("Stage Processing Time period filtering", () => {
  it("includes a stage completed exactly at the period start (6)", () => {
    const data = owned([stage("s", "r", "dean_office", T("10-31T00:00:00"), NOVEMBER.startUtc)]);
    const result = spt(AVERAGE, data.requests, data.stages);
    expect(result.overall).toEqual({ n: 1, value: value(24) });
  });

  it("excludes a stage completed exactly at the period end; it belongs to the next period (7)", () => {
    const data = owned([
      stage("last", "r1", "dean_office", T("11-30T00:00:00"), "2026-11-30T23:59:59.999Z"),
      stage("end", "r2", "dean_office", T("11-30T00:00:00"), NOVEMBER.endExclusiveUtc),
    ]);
    expect(ids(spt(AVERAGE, data.requests, data.stages, NOVEMBER).counted)).toEqual(["last"]);
    expect(ids(spt(AVERAGE, data.requests, data.stages, DECEMBER).counted)).toEqual(["end"]);
  });

  it("counts a stage that started before the period in the period it completed (8)", () => {
    const { requests, stages } = section5();
    expect(ids(spt(AVERAGE, requests, stages, NOVEMBER).counted)).toContain("D1");
    expect(ids(spt(AVERAGE, requests, stages, OCTOBER).counted)).toEqual([]);
  });

  it("counts completed stages of earlier workflow revisions (9)", () => {
    // Request H was amended: revision 1's first stage completed, its second was
    // cancelled by the amendment, and revision 2 restarted at stage 1.
    const data = owned([
      stage("H-r1-s1", "H", "department_budget", T("11-02T00:00:00"), T("11-02T10:00:00")),
      stage("H-r1-s2", "H", "dean_office", T("11-02T10:00:00"), T("11-03T00:00:00"), {
        stage_order: 2,
        status: "cancelled",
      }),
      stage("H-r2-s1", "H", "department_budget", T("11-04T00:00:00"), T("11-04T05:00:00"), {
        workflow_revision: 2,
      }),
    ]);
    const result = spt(AVERAGE, data.requests, data.stages);
    expect(ids(result.counted)).toEqual(["H-r1-s1", "H-r2-s1"]);
    expect(result.queues.recognized.department_budget).toEqual({ n: 2, value: value(7.5) });
    expect(excludedCodes(result)).toEqual([["H-r1-s2", "skipped_or_cancelled_stage"]]);
  });

  it("counts completed stages of rejected and completed-status requests (10)", () => {
    const rejected = owned(
      [stage("B1", "B", "department_budget", T("11-10T09:00:00"), T("11-10T21:00:00"))],
      "rejected",
    );
    expect(spt(AVERAGE, rejected.requests, rejected.stages).overall).toEqual({
      n: 1,
      value: value(12),
    });
    const completedStatus = owned(
      [stage("G1", "G", "dean_office", T("11-10T00:00:00"), T("11-11T00:00:00"))],
      "completed",
    );
    expect(spt(AVERAGE, completedStatus.requests, completedStatus.stages).overall).toEqual({
      n: 1,
      value: value(24),
    });
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("Stage Processing Time exclusions", () => {
  const good = () =>
    stage("good", "pending", "dean_office", T("11-02T00:00:00"), T("11-02T06:00:00"));

  it("applies each of the six conditions (11)", () => {
    const requests = [request("approved", "approved"), request("pending", "submitted")];
    const stages = [
      good(),
      stage("orphan", "approved", "dean_office", T("11-02T00:00:00"), null),
      stage("active", "pending", "dean_office", T("11-02T00:00:00"), null, { stage_order: 2 }),
      stage("skipped", "pending", "dean_office", null, null, { status: "skipped" }),
      stage("cancelled", "pending", "dean_office", T("11-02T00:00:00"), null, {
        status: "cancelled",
      }),
      stage("paused", "pending", "dean_office", T("11-02T00:00:00"), T("11-02T01:00:00"), {
        status: "paused",
      }),
      stage("null-status", "pending", "dean_office", T("11-02T00:00:00"), T("11-02T01:00:00"), {
        status: null as unknown as string,
      }),
      stage("no-completed", "pending", "dean_office", T("11-02T00:00:00"), null, {
        status: "completed",
      }),
      stage("bad-start", "pending", "dean_office", "2026-11-02", T("11-02T01:00:00")),
    ];
    const result = spt(AVERAGE, requests, stages);
    expect(ids(result.counted)).toEqual(["good"]);
    expect(excludedCodes(result)).toEqual([
      ["orphan", "orphaned_active_stage"],
      ["active", "in_progress_stage"],
      ["skipped", "skipped_or_cancelled_stage"],
      ["cancelled", "skipped_or_cancelled_stage"],
      ["paused", "unrecognized_stage_status"],
      ["null-status", "unrecognized_stage_status"],
      ["no-completed", "stage_missing_completed_at"],
      ["bad-start", "invalid_stage_timestamps"],
    ]);
    expect(result.population.exclusionCounts).toEqual({
      orphaned_active_stage: 1,
      in_progress_stage: 1,
      skipped_or_cancelled_stage: 2,
      unrecognized_stage_status: 2,
      stage_missing_completed_at: 1,
      invalid_stage_timestamps: 1,
    });
    expect(result.population.inScope).toBe(stages.length);
  });

  it("gives a stage failing several conditions only the earliest one (11, precedence)", () => {
    const requests = [request("approved", "approved"), request("pending", "submitted")];
    const stages = [
      // Active (1, 2) with an invalid start (6): orphaned wins over in-progress.
      stage("orphan+invalid", "approved", "dean_office", "garbage", null),
      // Active (2) with an invalid start (6).
      stage("active+invalid", "pending", "dean_office", "garbage", null),
      // Skipped (3) with no completed_at and invalid timestamps (6).
      stage("skipped+invalid", "pending", "dean_office", "garbage", null, { status: "skipped" }),
      // Unrecognized (4), no completed_at (5 would not apply), invalid start (6).
      stage("paused+invalid", "pending", "dean_office", "garbage", null, { status: "paused" }),
      // Completed with no completed_at (5) also fails timestamps (6).
      stage("missing+invalid", "pending", "dean_office", "garbage", null, {
        status: "completed",
      }),
    ];
    const result = spt(MEDIAN, requests, stages);
    expect(excludedCodes(result)).toEqual([
      ["orphan+invalid", "orphaned_active_stage"],
      ["active+invalid", "in_progress_stage"],
      ["skipped+invalid", "skipped_or_cancelled_stage"],
      ["paused+invalid", "unrecognized_stage_status"],
      ["missing+invalid", "stage_missing_completed_at"],
    ]);
    expect(result.population.exclusionCounts.invalid_stage_timestamps).toBe(0);
  });

  it("excludes invalid timestamps and end-before-start; equal instants are 0 h (12)", () => {
    const data = owned(
      [
        stage("date-only", "r", "dean_office", "2026-11-02", T("11-03T00:00:00")),
        stage("no-offset", "r", "dean_office", "2026-11-02T00:00:00", T("11-03T00:00:00")),
        stage("bad-end", "r", "dean_office", T("11-02T00:00:00"), "2026-11-03"),
        stage("null-start", "r", "dean_office", null, T("11-03T00:00:00")),
        stage("reversed", "r", "dean_office", T("11-03T00:00:00"), "2026-11-02T23:59:59.999Z"),
        stage("instant", "r", "dean_office", T("11-04T00:00:00"), T("11-04T00:00:00")),
      ],
      "submitted",
    );
    const result = spt(AVERAGE, data.requests, data.stages);
    expect(excludedCodes(result)).toEqual(
      ["date-only", "no-offset", "bad-end", "null-start", "reversed"].map((id) => [
        id,
        "invalid_stage_timestamps",
      ]),
    );
    expect(result.overall).toEqual({ n: 1, value: value(0) });
  });
});

// ---------------------------------------------------------------------------
// Flags and data-quality counts
// ---------------------------------------------------------------------------

describe("Stage Processing Time flags and data-quality counts", () => {
  it("flags unknown-queue stages without excluding them (13)", () => {
    const { requests, stages } = section5();
    const skippedUnknown = stage("U2", "U", "procurement", null, null, { status: "skipped" });
    const data = {
      requests: [...requests, request("U", "approved")],
      stages: [...stages, U1(), skippedUnknown],
    };
    const result = spt(AVERAGE, data.requests, data.stages);
    expect(result.population.flagCounts).toEqual({ unknown_queue: 1 });
    expect(result.population.flagged.map((f) => [f.record.id, f.flags])).toEqual([
      ["U1", ["unknown_queue"]],
    ]);
    expect(ids(result.counted)).toContain("U1");
    expect(ids(result.population.included)).toContain("U1");
    // An excluded unknown-queue stage is not flagged (flags apply to included records only).
    expect(excludedCodes(result)).toContainEqual(["U2", "skipped_or_cancelled_stage"]);
  });

  it("counts data quality over the whole dataset, whatever the period (14)", () => {
    const { requests, stages } = section5();
    const data = {
      requests: [...requests, request("U", "approved")],
      stages: [
        ...stages,
        U1(),
        stage("dec", "U", "dean_office", T("12-01T00:00:00"), T("12-02T00:00:00"), {
          stage_order: 2,
        }),
      ],
    };
    const results = [OCTOBER, NOVEMBER, DECEMBER, monthPeriod("2027-03")].map((p) =>
      spt(AVERAGE, data.requests, data.stages, p),
    );
    expect(results.map((r) => r.overall.n)).toEqual([0, 5, 1, 0]);
    for (const result of results) {
      expect(result.population).toEqual(results[0].population);
    }
    expect(results[0].population.exclusionCounts).toMatchObject({
      orphaned_active_stage: 1,
      in_progress_stage: 1,
    });
    expect(results[0].population.flagCounts).toEqual({ unknown_queue: 1 });
  });

  it("gives average and median the same population and data-quality counts", () => {
    const { requests, stages } = section5();
    expect(spt(AVERAGE, requests, stages).population).toEqual(
      spt(MEDIAN, requests, stages).population,
    );
  });
});

// ---------------------------------------------------------------------------
// Load gating
// ---------------------------------------------------------------------------

describe("Stage Processing Time load gating", () => {
  const { requests, stages } = section5();

  it("blocks when either required read failed, was incomplete or missed a field (15)", () => {
    const cases = [
      {
        loaded: load(failed("access"), complete(stages)),
        error: "request_read_failed",
        table: "financial_requests",
        issue: "access",
      },
      {
        loaded: load(incomplete(), complete(stages)),
        error: "request_read_incomplete",
        table: "financial_requests",
        issue: null,
      },
      {
        loaded: load(fieldMissing("status"), complete(stages)),
        error: "request_field_missing",
        table: "financial_requests",
        issue: null,
      },
      {
        loaded: load(complete(requests), failed("unavailable")),
        error: "stage_read_failed",
        table: "approval_stage_tracking",
        issue: "unavailable",
      },
      {
        loaded: load(complete(requests), incomplete()),
        error: "stage_read_incomplete",
        table: "approval_stage_tracking",
        issue: null,
      },
      {
        loaded: load(complete(requests), fieldMissing("started_at")),
        error: "stage_field_missing",
        table: "approval_stage_tracking",
        issue: null,
      },
    ] as const;
    for (const id of BOTH) {
      for (const { loaded, error, table, issue } of cases) {
        const result = calculateStageProcessingTime(id, { load: loaded, period: NOVEMBER });
        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") continue;
        expect(result.errors).toEqual([error]);
        expect(result.incompleteTables).toEqual([table]);
        expect(result.issue?.kind ?? null).toBe(issue);
        expect(result).not.toHaveProperty("overall");
        expect(result).toEqual(gateMetricLoad(id, loaded));
      }
    }
  });

  it("blocks on stage_request_not_loaded, since it needs every stage's request", () => {
    const loaded = load(complete(requests.filter((r) => r.id !== "A")), complete(stages));
    for (const id of BOTH) {
      const result = calculateStageProcessingTime(id, { load: loaded, period: NOVEMBER });
      expect(result).toMatchObject({
        status: "blocked",
        errors: ["stage_request_not_loaded"],
        incompleteTables: [],
      });
    }
  });

  it("blocks with both errors when both reads failed", () => {
    const result = calculateStageProcessingTime(AVERAGE, {
      load: load(failed("access"), incomplete()),
      period: NOVEMBER,
    });
    expect(result).toMatchObject({
      status: "blocked",
      errors: ["request_read_failed", "stage_read_incomplete"],
      incompleteTables: ["financial_requests", "approval_stage_tracking"],
    });
  });

  it("stays cancelled when either read was cancelled (16)", () => {
    for (const id of BOTH) {
      for (const loaded of [
        load(cancelled(), complete(stages)),
        load(complete(requests), cancelled()),
      ]) {
        expect(calculateStageProcessingTime(id, { load: loaded, period: NOVEMBER })).toEqual({
          status: "cancelled",
          metricId: id,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Guards and purity
// ---------------------------------------------------------------------------

describe("Stage Processing Time guards and purity", () => {
  it("does not modify its inputs and returns the caller's records in frozen containers (17)", () => {
    const { requests, stages } = section5();
    const loaded = loadOf([...requests, request("U", "approved")], [...stages, U1()]);
    const period = { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.endExclusiveUtc };
    const before = snapshot({ loaded, period });

    const result = calculated(calculateStageProcessingTime(MEDIAN, { load: loaded, period }));

    expect(snapshot({ loaded, period })).toEqual(before);
    expect(result.counted[0]).toBe(stages[0]);
    expect(result.population.excluded[0].record).toBe(stages[3]);
    for (const part of [
      result,
      result.overall,
      result.queues,
      result.queues.recognized,
      result.queues.unknown,
      result.queues.recognized.department_budget,
      result.counted,
      result.period,
      result.population,
      result.population.included,
      result.population.excluded,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it("throws for invalid period bounds instead of returning no-data", () => {
    const { requests, stages } = section5();
    for (const period of [
      { startUtc: "garbage", endExclusiveUtc: NOVEMBER.endExclusiveUtc },
      { startUtc: NOVEMBER.endExclusiveUtc, endExclusiveUtc: NOVEMBER.startUtc },
    ]) {
      expect(() =>
        calculateStageProcessingTime(AVERAGE, { load: loadOf(requests, stages), period }),
      ).toThrow(RangeError);
    }
  });

  it("throws when stage ids repeat, since a validated F19.3 load cannot contain duplicates", () => {
    const { requests, stages } = section5();
    const handBuilt: DatasetIntegrityResult = {
      status: "complete",
      dataset: {
        requests,
        stages: [...stages, { ...stages[0] }],
        consistency: "per-table-validated",
        reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
      },
    };
    expect(() =>
      calculateStageProcessingTime(AVERAGE, { load: handBuilt, period: NOVEMBER }),
    ).toThrow(/A1/);
  });

  it("imports only the F19.3 types, shared steps, classification, the catalog, stats and F18 types", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const source = read("./efficiency-stage-processing-time.ts");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-calculation",
      "@/lib/efficiency-classification",
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
      "@/lib/efficiency-stats",
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
      "./efficiency-stats.ts",
      "./efficiency-request-volume.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-stage-processing-time/);
    }
  });
});
