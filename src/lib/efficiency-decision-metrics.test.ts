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
import {
  calculateApprovalRate,
  calculateRequestTurnaroundTime,
  type ApprovalRateCalculated,
  type ApprovalRateResult,
  type RequestTurnaroundTimeCalculated,
  type RequestTurnaroundTimeMetricId,
  type RequestTurnaroundTimeResult,
} from "./efficiency-decision-metrics";
import {
  EFFICIENCY_METRICS,
  EFFICIENCY_METRICS_VERSION,
  TRACKED_TERMINAL_POPULATION,
  type DataQualityCode,
} from "./efficiency-metrics";
import { NO_DATA } from "./efficiency-stats";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes, real F18 periods
// ---------------------------------------------------------------------------

const AVERAGE = "request_turnaround_time_average";
const MEDIAN = "request_turnaround_time_median";
const TURNAROUND: RequestTurnaroundTimeMetricId[] = [AVERAGE, MEDIAN];
const TERMINAL_CODES: DataQualityCode[] = [
  "prototype_request",
  "completed_status",
  "invalid_created_at",
  "untracked_terminal_request",
  "terminal_request_with_active_stage",
  "terminal_stage_invalid",
  "decision_before_creation",
];

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
  createdAt: string,
): EfficiencyRequestRow {
  return { id, status, created_at: createdAt };
}

function stage(
  id: string,
  requestId: string,
  revision: number,
  order: number,
  status: string,
  completedAt: string | null,
  overrides: Partial<EfficiencyStageRow> = {},
): EfficiencyStageRow {
  return {
    id,
    request_id: requestId,
    workflow_revision: revision,
    stage_order: order,
    queue_id: "department_budget",
    status,
    started_at: T("10-01T00:00:00"),
    completed_at: completedAt,
    ...overrides,
  };
}

/** The docs/F19_Efficiency_Metrics.md section 5 dataset. */
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
    stage("A1", "A", 1, 1, "completed", T("11-04T13:00:00")),
    stage("A2", "A", 1, 2, "completed", T("11-07T01:00:00"), { queue_id: "dean_office" }),
    stage("B1", "B", 1, 1, "completed", T("11-10T21:00:00")),
    stage("C1", "C", 1, 1, "active", null, { queue_id: "research_admin" }),
    stage("D1", "D", 1, 1, "completed", T("11-01T12:00:00")),
    stage("E1", "E", 1, 1, "active", null),
  ];
  return { requests, stages };
}

/** The section 5.8 amended request H: decisive stage H3, TAT 84 h. */
function section58() {
  return {
    requests: [request("H", "approved", T("11-03T09:00:00"))],
    stages: [
      stage("H1", "H", 1, 1, "completed", T("11-04T09:00:00")),
      stage("H2", "H", 1, 2, "cancelled", T("11-05T09:00:00"), { queue_id: "dean_office" }),
      stage("H3", "H", 2, 1, "completed", T("11-06T21:00:00")),
    ],
  };
}

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

function tatCalculated(result: RequestTurnaroundTimeResult): RequestTurnaroundTimeCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}
function rateCalculated(result: ApprovalRateResult): ApprovalRateCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}

type Data = { requests: EfficiencyRequestRow[]; stages: EfficiencyStageRow[] };

const tat = (
  metricId: RequestTurnaroundTimeMetricId,
  data: Data,
  period: PeriodBounds = NOVEMBER,
  prototypeRequests?: EfficiencyRequestRow[],
) =>
  tatCalculated(
    calculateRequestTurnaroundTime(metricId, {
      load: loadOf(data.requests, data.stages),
      period,
      prototypeRequests,
    }),
  );

const rate = (
  data: Data,
  period: PeriodBounds = NOVEMBER,
  prototypeRequests?: EfficiencyRequestRow[],
) =>
  rateCalculated(
    calculateApprovalRate({ load: loadOf(data.requests, data.stages), period, prototypeRequests }),
  );

const merge = (...parts: Data[]): Data => ({
  requests: parts.flatMap((p) => p.requests),
  stages: parts.flatMap((p) => p.stages),
});

/** One request with its stages. */
const one = (
  id: string,
  status: EfficiencyRequestRow["status"],
  createdAt: string,
  stages: [string, number, number, string, string | null][],
  overrides: Partial<EfficiencyStageRow> = {},
): Data => ({
  requests: [request(id, status, createdAt)],
  stages: stages.map(([sid, revision, order, s, completedAt]) =>
    stage(sid, id, revision, order, s, completedAt, overrides),
  ),
});

/** A request decided `hours` after creation, both in November. */
const decidedAfter = (id: string, status: "approved" | "rejected", hours: number): Data => {
  const created = Date.parse(T("11-05T00:00:00"));
  return one(id, status, new Date(created).toISOString(), [
    [`${id}1`, 1, 1, "completed", new Date(created + hours * 3_600_000).toISOString()],
  ]);
};

const value = (v: number) => ({ kind: "value", value: v });
const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);
const excludedCodes = (result: { population: RequestTurnaroundTimeCalculated["population"] }) =>
  result.population.excluded.map((e) => [e.record.id, e.code]);

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (input: unknown) => JSON.parse(JSON.stringify(input));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("decision metrics catalog definitions", () => {
  it("share the tracked terminal population, reads, errors and decision-instant anchor", () => {
    for (const id of [...TURNAROUND, "approval_rate"] as const) {
      const metric = EFFICIENCY_METRICS[id];
      expect(metric.population).toBe(TRACKED_TERMINAL_POPULATION);
      expect(metric.requiredReads).toEqual(["financial_requests", "approval_stage_tracking"]);
      expect(metric.loadIntegrityErrors).toContain("stage_request_not_loaded");
      expect(metric.period).toMatchObject({
        mode: "period",
        anchor: { table: "approval_stage_tracking", field: "completed_at" },
      });
      expect(metric.emptyResult).toBe("no-data");
      expect(metric.flags).toEqual([]);
      expect(metric.groupings).toEqual(["overall"]);
    }
    expect(TRACKED_TERMINAL_POPULATION.subject).toBe("request");
    expect(TRACKED_TERMINAL_POPULATION.conditions.map((c) => c.exclusion)).toEqual(TERMINAL_CODES);
    expect(EFFICIENCY_METRICS[AVERAGE].statistic).toBe("average");
    expect(EFFICIENCY_METRICS[MEDIAN].statistic).toBe("median");
    expect(EFFICIENCY_METRICS.approval_rate.statistic).toBe("ratio");
    expect(EFFICIENCY_METRICS.approval_rate.unit).toBe("ratio");
  });

  it("report the metric, version, period and exclusion counts in catalog order", () => {
    const data = section5();
    for (const result of [tat(AVERAGE, data), tat(MEDIAN, data), rate(data)]) {
      expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
      expect(result.period).toEqual({
        startUtc: NOVEMBER.startUtc,
        endExclusiveUtc: NOVEMBER.endExclusiveUtc,
      });
      expect(Object.keys(result.population.exclusionCounts)).toEqual(TERMINAL_CODES);
    }
    expect(tat(MEDIAN, data)).toMatchObject({ metricId: MEDIAN, statistic: "median" });
    expect(rate(data).metricId).toBe("approval_rate");
  });

  it("rejects a metric id outside the turnaround family", () => {
    expect(() =>
      calculateRequestTurnaroundTime("approval_rate" as RequestTurnaroundTimeMetricId, {
        load: loadOf([], []),
        period: NOVEMBER,
      }),
    ).toThrow(/not a request turnaround time metric/);
  });
});

// ---------------------------------------------------------------------------
// Request Turnaround Time: values
// ---------------------------------------------------------------------------

describe("Request Turnaround Time values", () => {
  it("measures (T(r) - created_at) / 3,600,000 ms from the decisive stage (1)", () => {
    const result = tat(
      AVERAGE,
      one("A", "approved", T("11-02T12:58:30"), [
        ["A1", 1, 1, "completed", T("11-04T13:00:00")],
        ["A2", 1, 2, "completed", T("11-07T01:00:00")],
      ]),
    );
    // 4 days 12 h 1 min 30 s = 108.025 h, to the decisive stage A2.
    expect(result.value).toEqual(value(108.025));
    expect(result.n).toBe(1);
  });

  it("reproduces section 5.4: average 56.02 h and median 48.02 h (odd n) (2, 9)", () => {
    const data = section5();
    const avg = tat(AVERAGE, data);
    const med = tat(MEDIAN, data);
    expect(ids(avg.counted)).toEqual(["A", "B", "D"]); // approved A, D and rejected B
    expect(avg.n).toBe(3);
    const a = 108.025;
    const b = 12 + 1 / 60;
    const d = 48 + 1 / 60;
    expect(avg.value.kind).toBe("value");
    if (avg.value.kind === "value") {
      expect(avg.value.value).toBeCloseTo((a + b + d) / 3, 12);
      expect(avg.value.value).toBeCloseTo(56.02, 2);
    }
    expect(med.value.kind).toBe("value");
    if (med.value.kind === "value") expect(med.value.value).toBeCloseTo(d, 12);
  });

  it("takes the mean of the two middle values for an even count (2)", () => {
    const data = merge(
      decidedAfter("r1", "approved", 1),
      decidedAfter("r2", "rejected", 2),
      decidedAfter("r3", "approved", 3),
      decidedAfter("r4", "approved", 10),
    );
    expect(tat(MEDIAN, data)).toMatchObject({ n: 4, value: value(2.5) });
    expect(tat(AVERAGE, data)).toMatchObject({ n: 4, value: value(4) });
  });

  it("returns no-data, never 0, for an empty population (3)", () => {
    for (const id of TURNAROUND) {
      expect(tat(id, { requests: [], stages: [] })).toMatchObject({ n: 0, value: NO_DATA });
      expect(tat(id, section5(), monthPeriod("2027-03"))).toMatchObject({ n: 0, value: NO_DATA });
      // Every request excluded.
      const onlyExcluded = one("C", "approved", T("11-12T10:00:00"), [
        ["C1", 1, 1, "active", null],
      ]);
      expect(tat(id, onlyExcluded).value).toEqual(NO_DATA);
    }
  });

  it("measures an amended request from its original created_at to the final revision (8, section 5.8)", () => {
    const result = tat(AVERAGE, section58());
    expect(result.value).toEqual(value(84));
    expect(excludedCodes(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Period filtering (shared)
// ---------------------------------------------------------------------------

describe("decision-time period filtering", () => {
  it("assigns a request to the period of T(r), not created_at (4, 6, 7)", () => {
    const data = merge(
      // Created in October, decided in November (section 5 D).
      one("D", "approved", T("10-30T11:59:00"), [["D1", 1, 1, "completed", T("11-01T12:00:00")]]),
      // Created in November, decided in December.
      one("late", "rejected", T("11-28T00:00:00"), [
        ["L1", 1, 1, "completed", T("12-02T00:00:00")],
      ]),
    );
    expect(ids(tat(AVERAGE, data, NOVEMBER).counted)).toEqual(["D"]);
    expect(ids(tat(AVERAGE, data, DECEMBER).counted)).toEqual(["late"]);
    expect(ids(tat(AVERAGE, data, OCTOBER).counted)).toEqual([]);
    expect(ids(rate(data, NOVEMBER).counted)).toEqual(["D"]);
    expect(rate(data, DECEMBER)).toMatchObject({ approved: 0, rejected: 1, value: value(0) });
  });

  it("includes T(r) exactly at the period start and excludes it exactly at the end (5)", () => {
    const data = merge(
      one("start", "approved", T("10-31T00:00:00"), [["S1", 1, 1, "completed", NOVEMBER.startUtc]]),
      one("last", "approved", T("11-30T00:00:00"), [
        ["L1", 1, 1, "completed", "2026-11-30T23:59:59.999Z"],
      ]),
      one("end", "rejected", T("11-30T00:00:00"), [
        ["E1", 1, 1, "completed", NOVEMBER.endExclusiveUtc],
      ]),
    );
    expect(ids(tat(AVERAGE, data, NOVEMBER).counted)).toEqual(["start", "last"]);
    expect(ids(tat(AVERAGE, data, DECEMBER).counted)).toEqual(["end"]);
    expect(ids(rate(data, NOVEMBER).counted)).toEqual(["start", "last"]);
    expect(ids(rate(data, DECEMBER).counted)).toEqual(["end"]);
  });

  it("uses the decisive stage's completed_at even when an earlier stage completed in another period", () => {
    // H1 completed in October, the decisive H3 in November.
    const data = one("H", "approved", T("10-20T00:00:00"), [
      ["H1", 1, 1, "completed", T("10-25T00:00:00")],
      ["H2", 2, 1, "completed", T("11-02T00:00:00")],
    ]);
    expect(ids(tat(AVERAGE, data, NOVEMBER).counted)).toEqual(["H"]);
    expect(ids(tat(AVERAGE, data, OCTOBER).counted)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Terminal eligibility and exclusions (shared population)
// ---------------------------------------------------------------------------

describe("tracked terminal eligibility", () => {
  const created = T("11-01T00:00:00");

  it("excludes completed-status requests under completed_status, never as approved (10)", () => {
    const data = one("G", "completed", created, [["G1", 1, 1, "completed", T("11-02T00:00:00")]]);
    expect(excludedCodes(tat(AVERAGE, data))).toEqual([["G", "completed_status"]]);
    expect(rate(data)).toMatchObject({ approved: 0, rejected: 0, value: NO_DATA });
  });

  it("excludes prototype requests in scope; pending prototypes are outside the scope (11)", () => {
    const decidedPrototype = request("proto", "approved", created);
    const pendingPrototype = request("proto-pending", "submitted", created);
    const result = tat(AVERAGE, section5(), NOVEMBER, [decidedPrototype, pendingPrototype]);
    expect(result.population.excluded).toContainEqual({
      record: decidedPrototype,
      code: "prototype_request",
    });
    expect(result.population.exclusionCounts.prototype_request).toBe(1);
    expect(ids(result.population.excluded.map((e) => e.record))).not.toContain("proto-pending");
    expect(rate(section5(), NOVEMBER, [decidedPrototype]).population.exclusionCounts).toEqual(
      result.population.exclusionCounts,
    );
  });

  it("excludes decided requests with no stage records (12)", () => {
    const data = { requests: [request("old", "approved", created)], stages: [] };
    expect(excludedCodes(tat(AVERAGE, data))).toEqual([["old", "untracked_terminal_request"]]);
  });

  it("excludes a request with an active stage in any revision (13)", () => {
    const data = merge(
      // Section 5 C: the active stage is also the decisive one.
      one("C", "approved", created, [["C1", 1, 1, "active", null]]),
      // An active stage in an earlier revision, below a completed decisive stage.
      one("old-active", "approved", created, [
        ["OA1", 1, 1, "active", null],
        ["OA2", 2, 1, "completed", T("11-03T00:00:00")],
      ]),
    );
    expect(excludedCodes(tat(AVERAGE, data))).toEqual([
      ["C", "terminal_request_with_active_stage"],
      ["old-active", "terminal_request_with_active_stage"],
    ]);
  });

  it("picks the highest (workflow_revision, stage_order), comparing integers (14)", () => {
    const data = merge(
      // Revision 2 beats a higher stage_order in revision 1 (section 5.8).
      section58(),
      // Revision 10 beats revision 9: numeric, not text, ordering.
      one("R10", "approved", created, [
        ["R9", 9, 3, "completed", T("11-20T00:00:00")],
        ["R10s", 10, 1, "completed", T("11-10T00:00:00")],
      ]),
    );
    const result = tat(AVERAGE, data);
    expect(ids(result.counted)).toEqual(["H", "R10"]);
    // R10 decided at 11-10 (revision 10), not 11-20 (revision 9): 216 h.
    expect(
      tat(AVERAGE, { requests: [data.requests[1]], stages: data.stages.slice(3) }).value,
    ).toEqual(value(216));
  });

  it("is invalid on a tie at the highest pair, but not on a tie below it (15)", () => {
    const data = merge(
      one("top-tie", "approved", created, [
        ["TT1", 1, 2, "completed", T("11-03T00:00:00")],
        ["TT2", 1, 2, "completed", T("11-04T00:00:00")],
      ]),
      one("lower-tie", "approved", created, [
        ["LT1", 1, 1, "completed", T("11-02T00:00:00")],
        ["LT2", 1, 1, "cancelled", T("11-02T00:00:00")],
        ["LT3", 1, 2, "completed", T("11-03T00:00:00")],
      ]),
    );
    const result = tat(AVERAGE, data);
    expect(excludedCodes(result)).toEqual([["top-tie", "terminal_stage_invalid"]]);
    expect(ids(result.counted)).toEqual(["lower-tie"]);
    expect(result.value).toEqual(value(48));
  });

  it("is invalid when any stage has a null or non-integer ordering key (16)", () => {
    const keys: [unknown, unknown][] = [
      [null, 1],
      [1, null],
      [1.5, 1],
      ["1", 1],
      [Number.NaN, 1],
    ];
    const data = merge(
      ...keys.map(([revision, order], i) =>
        one(`bad-${i}`, "approved", created, [
          // A low, invalid-key stage below a valid completed decisive candidate.
          [`bad-${i}-a`, revision as number, order as number, "completed", T("11-02T00:00:00")],
          [`bad-${i}-b`, 5, 5, "completed", T("11-03T00:00:00")],
        ]),
      ),
    );
    const result = tat(AVERAGE, data);
    expect(excludedCodes(result)).toEqual(
      keys.map((_, i) => [`bad-${i}`, "terminal_stage_invalid"]),
    );
  });

  it("is invalid when the decisive stage's completed_at is missing or not a valid instant (17)", () => {
    const data = merge(
      one("missing", "approved", created, [["M1", 1, 1, "completed", null]]),
      one("date-only", "approved", created, [["D1", 1, 1, "completed", "2026-11-03"]]),
      one("no-offset", "rejected", created, [["N1", 1, 1, "completed", "2026-11-03T00:00:00"]]),
      one("garbage", "rejected", created, [["G1", 1, 1, "completed", "garbage"]]),
    );
    expect(excludedCodes(tat(AVERAGE, data))).toEqual(
      ["missing", "date-only", "no-offset", "garbage"].map((id) => [id, "terminal_stage_invalid"]),
    );
  });

  it("never falls back to an earlier completed stage (18)", () => {
    const data = merge(
      one("cancelled-top", "approved", created, [
        ["CT1", 1, 1, "completed", T("11-02T00:00:00")],
        ["CT2", 1, 2, "cancelled", T("11-03T00:00:00")],
      ]),
      one("skipped-top", "rejected", created, [
        ["ST1", 1, 1, "completed", T("11-02T00:00:00")],
        ["ST2", 2, 1, "skipped", null],
      ]),
      one("bad-time-top", "approved", created, [
        ["BT1", 1, 1, "completed", T("11-02T00:00:00")],
        ["BT2", 1, 2, "completed", "garbage"],
      ]),
      one("unknown-status-top", "approved", created, [
        ["US1", 1, 1, "completed", T("11-02T00:00:00")],
        ["US2", 1, 2, "paused", T("11-03T00:00:00")],
      ]),
    );
    const result = tat(AVERAGE, data);
    expect(result.counted).toEqual([]);
    expect(excludedCodes(result).map(([, code]) => code)).toEqual(
      Array(4).fill("terminal_stage_invalid"),
    );
  });

  it("excludes a decision before creation; equal instants are a valid 0 h (19)", () => {
    const data = merge(
      one("before", "approved", T("11-20T00:00:00"), [
        ["B1", 1, 1, "completed", T("11-19T00:00:00")],
      ]),
      one("one-ms", "rejected", "2026-11-20T00:00:00.001Z", [
        ["B2", 1, 1, "completed", "2026-11-20T00:00:00.000Z"],
      ]),
      one("equal", "approved", T("11-21T00:00:00"), [
        ["E1", 1, 1, "completed", T("11-21T00:00:00")],
      ]),
    );
    const result = tat(AVERAGE, data);
    expect(excludedCodes(result)).toEqual([
      ["before", "decision_before_creation"],
      ["one-ms", "decision_before_creation"],
    ]);
    expect(result).toMatchObject({ n: 1, value: value(0) });
    expect(rate(data)).toMatchObject({ approved: 1, rejected: 0, value: value(1) });
  });

  it("applies all seven conditions, in catalog order, one code per request (20)", () => {
    const prototype = request("p-invalid", "approved", "garbage");
    const data = merge(
      one("ok", "approved", created, [["OK1", 1, 1, "completed", T("11-02T00:00:00")]]),
      // completed (2) with invalid created_at (3) and no stages (4).
      { requests: [request("completed+", "completed", "garbage")], stages: [] },
      // invalid created_at (3) with no stages (4).
      { requests: [request("invalid+", "rejected", "garbage")], stages: [] },
      // no stages (4).
      { requests: [request("untracked", "approved", created)], stages: [] },
      // active stage (5) that is also decisive with no completed_at (6).
      one("active+", "approved", created, [["AC1", 1, 1, "active", null]]),
      // top-pair tie (6) whose completed_at precedes created_at (7).
      one("invalid+before", "approved", T("11-20T00:00:00"), [
        ["IB1", 1, 1, "completed", T("11-02T00:00:00")],
        ["IB2", 1, 1, "completed", T("11-02T00:00:00")],
      ]),
      one("before", "rejected", T("11-20T00:00:00"), [
        ["BF1", 1, 1, "completed", T("11-02T00:00:00")],
      ]),
      // Pending: outside the scope, never counted.
      one("pending", "submitted", created, [["PE1", 1, 1, "active", null]]),
    );
    for (const result of [
      tat(AVERAGE, data, NOVEMBER, [prototype]),
      rate(data, NOVEMBER, [prototype]),
    ]) {
      expect(excludedCodes(result)).toEqual([
        ["completed+", "completed_status"],
        ["invalid+", "invalid_created_at"],
        ["untracked", "untracked_terminal_request"],
        ["active+", "terminal_request_with_active_stage"],
        ["invalid+before", "terminal_stage_invalid"],
        ["before", "decision_before_creation"],
        ["p-invalid", "prototype_request"],
      ]);
      expect(result.population.exclusionCounts).toEqual(
        Object.fromEntries(TERMINAL_CODES.map((code) => [code, 1])),
      );
      expect(result.population.inScope).toBe(8);
      expect(ids(result.counted)).toEqual(["ok"]);
    }
  });

  it("counts data quality over the whole dataset, whatever the period (21)", () => {
    const data = merge(
      section5(),
      one("dec", "approved", T("11-28T00:00:00"), [
        ["DEC1", 1, 1, "completed", T("12-03T00:00:00")],
      ]),
      { requests: [request("untracked", "approved", T("11-01T00:00:00"))], stages: [] },
    );
    const periods = [OCTOBER, NOVEMBER, DECEMBER, monthPeriod("2027-03")];
    const tats = periods.map((p) => tat(MEDIAN, data, p));
    const rates = periods.map((p) => rate(data, p));
    expect(tats.map((r) => r.n)).toEqual([0, 3, 1, 0]);
    for (const result of [...tats, ...rates]) {
      expect(result.population).toEqual(tats[0].population);
    }
    expect(tats[0].population.exclusionCounts).toMatchObject({
      untracked_terminal_request: 1,
      terminal_request_with_active_stage: 1,
    });
  });

  it("is not affected by stage-level flags such as unknown_queue or duplicate active stages (22)", () => {
    const data = merge(
      one(
        "unknown-queue",
        "approved",
        T("11-01T00:00:00"),
        [["UQ1", 1, 1, "completed", T("11-02T00:00:00")]],
        { queue_id: "procurement" },
      ),
      section5(),
    );
    const result = tat(AVERAGE, data);
    expect(ids(result.counted)).toEqual(["unknown-queue", "A", "B", "D"]);
    expect(result.population.flagged).toEqual([]);
    expect(result.population.flagCounts).toEqual({});
    expect(rate(data)).toMatchObject({ approved: 3, rejected: 1 });
  });
});

// ---------------------------------------------------------------------------
// Approval Rate
// ---------------------------------------------------------------------------

describe("Approval Rate", () => {
  it("reproduces section 5.5: 2 approved / 3 decided (1)", () => {
    const result = rate(section5());
    expect(result).toMatchObject({ approved: 2, rejected: 1 });
    expect(result.value.kind).toBe("value");
    if (result.value.kind === "value") expect(result.value.value).toBeCloseTo(2 / 3, 15);
    expect(ids(result.counted)).toEqual(["A", "B", "D"]);
  });

  it("is a fraction from 0 to 1 over many approved and rejected requests (2)", () => {
    const data = merge(
      ...[1, 2, 3].map((i) => decidedAfter(`a${i}`, "approved", i)),
      ...[4, 5, 6, 7, 8].map((i) => decidedAfter(`r${i}`, "rejected", i)),
    );
    expect(rate(data)).toMatchObject({ approved: 3, rejected: 5, value: value(3 / 8) });
    expect(rate(merge(decidedAfter("a", "approved", 1)))).toMatchObject({ value: value(1) });
    expect(rate(merge(decidedAfter("r", "rejected", 1)))).toMatchObject({ value: value(0) });
  });

  it("never puts completed-status requests in the denominator (3)", () => {
    const data = merge(
      decidedAfter("a", "approved", 1),
      decidedAfter("r", "rejected", 1),
      one("done", "completed", T("11-01T00:00:00"), [
        ["DN1", 1, 1, "completed", T("11-02T00:00:00")],
      ]),
    );
    const result = rate(data);
    expect(result).toMatchObject({ approved: 1, rejected: 1, value: value(0.5) });
    expect(result.population.exclusionCounts.completed_status).toBe(1);
  });

  it("returns no-data, never 0 or 0%, when nothing was decided (4)", () => {
    expect(rate({ requests: [], stages: [] })).toMatchObject({
      approved: 0,
      rejected: 0,
      value: NO_DATA,
    });
    expect(rate(section5(), monthPeriod("2027-03")).value).toEqual(NO_DATA);
  });

  it("uses exactly turnaround's population, decision-time period and counted requests (5, 7, 8)", () => {
    const data = merge(section5(), section58());
    for (const period of [OCTOBER, NOVEMBER, DECEMBER]) {
      const turnaround = tat(AVERAGE, data, period);
      const approval = rate(data, period);
      expect(approval.population).toEqual(turnaround.population);
      expect(approval.counted).toEqual(turnaround.counted);
      expect(approval.approved + approval.rejected).toBe(turnaround.n);
    }
  });

  it("does not use the dashboard approvalRate helper (11)", () => {
    const source = readFileSync(
      new URL("./efficiency-decision-metrics.ts", import.meta.url),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/analytics-utils|calculateAnalyticsSummary|approvalRate/);
    // The dashboard formula would give approved / all requests = 3 / 6 = 0.5 here.
    expect(rate(section5()).value).not.toEqual(value(0.5));
  });
});

// ---------------------------------------------------------------------------
// Load gating
// ---------------------------------------------------------------------------

describe("decision metrics load gating", () => {
  const { requests, stages } = section5();
  const calculators = [
    (loaded: DatasetIntegrityResult) =>
      calculateRequestTurnaroundTime(AVERAGE, { load: loaded, period: NOVEMBER }),
    (loaded: DatasetIntegrityResult) =>
      calculateRequestTurnaroundTime(MEDIAN, { load: loaded, period: NOVEMBER }),
    (loaded: DatasetIntegrityResult) => calculateApprovalRate({ load: loaded, period: NOVEMBER }),
  ];
  const metricIds = [AVERAGE, MEDIAN, "approval_rate"] as const;

  it("blocks when either required read failed, was incomplete or missed a field (TAT 23, AR 9)", () => {
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
        loaded: load(fieldMissing("created_at"), complete(stages)),
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
        loaded: load(complete(requests), fieldMissing("workflow_revision")),
        error: "stage_field_missing",
        table: "approval_stage_tracking",
        issue: null,
      },
    ] as const;
    calculators.forEach((calculate, i) => {
      for (const { loaded, error, table, issue } of cases) {
        const result = calculate(loaded);
        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") continue;
        expect(result.errors).toEqual([error]);
        expect(result.incompleteTables).toEqual([table]);
        expect(result.issue?.kind ?? null).toBe(issue);
        expect(result).not.toHaveProperty("value");
        expect(result).toEqual(gateMetricLoad(metricIds[i], loaded));
      }
    });
  });

  it("blocks on stage_request_not_loaded and when both reads failed", () => {
    const notLoaded = load(complete(requests.filter((r) => r.id !== "A")), complete(stages));
    const both = load(failed("access"), incomplete());
    for (const calculate of calculators) {
      expect(calculate(notLoaded)).toMatchObject({
        status: "blocked",
        errors: ["stage_request_not_loaded"],
      });
      expect(calculate(both)).toMatchObject({
        status: "blocked",
        errors: ["request_read_failed", "stage_read_incomplete"],
        incompleteTables: ["financial_requests", "approval_stage_tracking"],
      });
    }
  });

  it("stays cancelled when either read was cancelled (TAT 24, AR 10)", () => {
    calculators.forEach((calculate, i) => {
      for (const loaded of [
        load(cancelled(), complete(stages)),
        load(complete(requests), cancelled()),
      ]) {
        expect(calculate(loaded)).toEqual({ status: "cancelled", metricId: metricIds[i] });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Guards and purity
// ---------------------------------------------------------------------------

describe("decision metrics guards and purity", () => {
  it("do not modify their inputs and return the caller's records in frozen containers (25)", () => {
    const data = merge(section5(), section58());
    const loaded = loadOf(data.requests, data.stages);
    const period = { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.endExclusiveUtc };
    const prototypes = [request("proto", "approved", T("11-01T00:00:00"))];
    const before = snapshot({ loaded, period, prototypes });

    const turnaround = tatCalculated(
      calculateRequestTurnaroundTime(MEDIAN, {
        load: loaded,
        period,
        prototypeRequests: prototypes,
      }),
    );
    const approval = rateCalculated(
      calculateApprovalRate({ load: loaded, period, prototypeRequests: prototypes }),
    );

    expect(snapshot({ loaded, period, prototypes })).toEqual(before);
    expect(turnaround.counted[0]).toBe(data.requests[0]);
    expect(approval.population.excluded.at(-1)?.record).toBe(prototypes[0]);
    for (const part of [
      turnaround,
      turnaround.value,
      turnaround.counted,
      turnaround.period,
      turnaround.population,
      approval,
      approval.value,
      approval.counted,
      approval.population.excluded,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it("throw for invalid period bounds instead of returning no-data", () => {
    const loaded = loadOf(section5().requests, section5().stages);
    const period = { startUtc: NOVEMBER.endExclusiveUtc, endExclusiveUtc: NOVEMBER.startUtc };
    expect(() => calculateRequestTurnaroundTime(AVERAGE, { load: loaded, period })).toThrow(
      RangeError,
    );
    expect(() => calculateApprovalRate({ load: loaded, period })).toThrow(RangeError);
  });

  it("throw when ids repeat, since a validated F19.3 load cannot contain duplicates", () => {
    const { requests, stages } = section5();
    const handBuilt: DatasetIntegrityResult = {
      status: "complete",
      dataset: {
        requests: [...requests, { ...requests[1] }],
        stages,
        consistency: "per-table-validated",
        reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
      },
    };
    expect(() =>
      calculateRequestTurnaroundTime(AVERAGE, { load: handBuilt, period: NOVEMBER }),
    ).toThrow(/ids repeat \(B\)/);
    expect(() => calculateApprovalRate({ load: handBuilt, period: NOVEMBER })).toThrow(
      /ids repeat \(B\)/,
    );
  });

  it("documents the caller's prototype owner-scoping responsibility", () => {
    const source = readFileSync(
      new URL("./efficiency-decision-metrics.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/caller MUST scope them to the\s+\* signed-in owner/);
  });

  it("imports only the F19.3 types, shared steps, classification, the catalog, dataset helpers, stats and F18 types", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const source = read("./efficiency-decision-metrics.ts");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-calculation",
      "@/lib/efficiency-classification",
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
      "@/lib/efficiency-population",
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
      "./efficiency-stage-processing-time.ts",
      "./efficiency-queue-throughput.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-decision-metrics/);
    }
  });
});
