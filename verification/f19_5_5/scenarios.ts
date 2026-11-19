/**
 * F19.5.5 synthetic scenarios and their HAND-DERIVED expected results.
 *
 * Method: every expected value below was worked out by hand from
 * docs/F19_Efficiency_Metrics.md (sections 3-6, examples in section 5) and
 * written as the arithmetic itself (for example 192 / 7), never by calling
 * an F19 calculator. Conventions of the compact form (harness.ts `expand`):
 * omitted exclusion and flag codes are 0, omitted recognized queues are 0
 * (counts) or { n: 0, value: "no-data" } (durations), an omitted unknown
 * group is absent. `inScope` / `included` describe the whole supplied
 * dataset (DATA_QUALITY_RULES 5); values, n and queue groups describe the
 * reporting period.
 *
 * Database-backed scenarios (S5, S58, SX) take their rows from
 * fixtures/db-scenarios.json; the rest are TypeScript-only because the
 * database constraints cannot store them (see README.md).
 */
import dbFixtures from "./fixtures/db-scenarios.json";
import type { Expected, LoadSpec, TableSpec } from "./harness";
import type { EfficiencyRequestRow } from "../../src/lib/efficiency-data";
import { getCalendarMonthPeriod } from "../../src/lib/reporting-periods";
import {
  validateCustomDateRange,
  CUSTOM_DATE_RANGE_TIME_ZONE,
} from "../../src/lib/date-range-filter";
import type { PeriodBounds } from "../../src/lib/time-zones";

// ---------------------------------------------------------------------------
// Periods (real F18 builders)
// ---------------------------------------------------------------------------

const month = (key: string): PeriodBounds => {
  const p = getCalendarMonthPeriod(key);
  if (!p) throw new Error(key);
  return { startUtc: p.startUtc, endExclusiveUtc: p.endExclusiveUtc };
};
const easternDay = (date: string): PeriodBounds => {
  const r = validateCustomDateRange({
    startDate: date,
    endDate: date,
    timeZone: CUSTOM_DATE_RANGE_TIME_ZONE,
  });
  if (!r.ok) throw new Error(date);
  return { startUtc: r.range.startUtc, endExclusiveUtc: r.range.endExclusiveUtc };
};
export const PERIODS = {
  oct: month("2026-10"),
  nov: month("2026-11"),
  dec: month("2026-12"),
  eastern_2026_10_31: easternDay("2026-10-31"),
} as const;
export type PeriodKey = keyof typeof PERIODS;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const req = (id: string, status: unknown, created_at: unknown): Row => ({ id, status, created_at });
const stg = (
  id: string,
  request_id: string,
  workflow_revision: unknown,
  stage_order: unknown,
  queue_id: unknown,
  status: unknown,
  started_at: unknown,
  completed_at: unknown,
): Row => ({
  id,
  request_id,
  workflow_revision,
  stage_order,
  queue_id,
  status,
  started_at,
  completed_at,
});

type DbScenario = { requests: (Row & { label: string })[]; stages: (Row & { label: string })[] };
const dbScenario = (key: "S5" | "S58" | "SX") =>
  (dbFixtures.scenarios as Record<string, DbScenario>)[key];
/** Loader columns only, as the F19.3 select returns them. */
export const dbRows = (key: "S5" | "S58" | "SX") => ({
  requests: dbScenario(key).requests.map(({ id, status, created_at }) => ({
    id,
    status,
    created_at,
  })),
  stages: dbScenario(key).stages.map(
    ({
      id,
      request_id,
      workflow_revision,
      stage_order,
      queue_id,
      status,
      started_at,
      completed_at,
    }) => ({
      id,
      request_id,
      workflow_revision,
      stage_order,
      queue_id,
      status,
      started_at,
      completed_at,
    }),
  ),
});

const DEPT = "department_budget",
  DEAN = "dean_office",
  RES = "research_admin",
  PROV = "provost_finance",
  SPON = "sponsored_programs",
  CFO = "cfo_office";

// Shared expectation fragments.
const noStages = { overall: { n: 0, value: "no-data" as const } };
const workloadNone = { inScope: 0, included: 0, pending_without_stage: { count: 0, inScope: 0 } };

// ---------------------------------------------------------------------------
// S5: spec section 5 (database-backed)
// ---------------------------------------------------------------------------

// TAT(A) = 11-02T12:58:30 -> 11-07T01:00 = 108 h 1.5 min; TAT(B) = 12 h 1 min; TAT(D) = 48 h 1 min.
const TAT_A = 108 + 1.5 / 60,
  TAT_B = 12 + 1 / 60,
  TAT_D = 48 + 1 / 60;
const S5_WORKLOAD = {
  inScope: 2,
  included: 1,
  exclusions: { orphaned_active_stage: 1 },
  queues: { [DEPT]: 1 },
  pending_without_stage: { count: 1, inScope: 1 },
};
const S5_SPT_POP = {
  inScope: 6,
  included: 4,
  exclusions: { orphaned_active_stage: 1, in_progress_stage: 1 },
};
const S5_TERMINAL_POP = {
  inScope: 4,
  included: 3,
  exclusions: { terminal_request_with_active_stage: 1 },
};
const S5_THROUGHPUT_POP = { inScope: 4, included: 4 };

const s5Nov: Expected = {
  request_volume: { value: 5, inScope: 6, included: 6 }, // A, B, C, E, F; D is October
  active_queue_workload: S5_WORKLOAD,
  stage_processing_time_average: {
    ...S5_SPT_POP,
    overall: { n: 4, value: (12 + 48 + 48 + 60) / 4 },
    queues: { [DEPT]: { n: 3, value: (48 + 12 + 48) / 3 }, [DEAN]: { n: 1, value: 60 } },
  },
  stage_processing_time_median: {
    ...S5_SPT_POP,
    overall: { n: 4, value: (48 + 48) / 2 },
    queues: { [DEPT]: { n: 3, value: 48 }, [DEAN]: { n: 1, value: 60 } },
  },
  request_turnaround_time_average: { ...S5_TERMINAL_POP, n: 3, value: (TAT_A + TAT_B + TAT_D) / 3 },
  request_turnaround_time_median: { ...S5_TERMINAL_POP, n: 3, value: TAT_D },
  approval_rate: { ...S5_TERMINAL_POP, approved: 2, rejected: 1, value: 2 / 3 },
  queue_throughput: { ...S5_THROUGHPUT_POP, overall: 4, queues: { [DEPT]: 3, [DEAN]: 1 } },
};
const s5Quiet = (volume: number): Expected => ({
  request_volume: { value: volume, inScope: 6, included: 6 },
  active_queue_workload: S5_WORKLOAD,
  stage_processing_time_average: { ...S5_SPT_POP, ...noStages },
  stage_processing_time_median: { ...S5_SPT_POP, ...noStages },
  request_turnaround_time_average: { ...S5_TERMINAL_POP, n: 0, value: "no-data" },
  request_turnaround_time_median: { ...S5_TERMINAL_POP, n: 0, value: "no-data" },
  approval_rate: { ...S5_TERMINAL_POP, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { ...S5_THROUGHPUT_POP, overall: 0 },
});

// ---------------------------------------------------------------------------
// S58: spec section 5.8 (database-backed)
// ---------------------------------------------------------------------------

const S58_SPT_POP = { inScope: 3, included: 2, exclusions: { skipped_or_cancelled_stage: 1 } };
const s58Nov: Expected = {
  request_volume: { value: 1, inScope: 1, included: 1 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    ...S58_SPT_POP,
    overall: { n: 2, value: (24 + 36) / 2 },
    queues: { [DEPT]: { n: 2, value: (24 + 36) / 2 } },
  },
  stage_processing_time_median: {
    ...S58_SPT_POP,
    overall: { n: 2, value: (24 + 36) / 2 },
    queues: { [DEPT]: { n: 2, value: (24 + 36) / 2 } },
  },
  // H3 (revision 2) is decisive: 11-03T09:00 -> 11-06T21:00 = 84 h.
  request_turnaround_time_average: { inScope: 1, included: 1, n: 1, value: 84 },
  request_turnaround_time_median: { inScope: 1, included: 1, n: 1, value: 84 },
  approval_rate: { inScope: 1, included: 1, approved: 1, rejected: 0, value: 1 },
  queue_throughput: { ...S58_SPT_POP, overall: 2, queues: { [DEPT]: 2 } },
};
const s58Quiet: Expected = {
  request_volume: { value: 0, inScope: 1, included: 1 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: { ...S58_SPT_POP, ...noStages },
  stage_processing_time_median: { ...S58_SPT_POP, ...noStages },
  request_turnaround_time_average: { inScope: 1, included: 1, n: 0, value: "no-data" },
  request_turnaround_time_median: { inScope: 1, included: 1, n: 0, value: "no-data" },
  approval_rate: { inScope: 1, included: 1, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { ...S58_SPT_POP, overall: 0 },
};

// ---------------------------------------------------------------------------
// SX: storable edge cases (database-backed)
// ---------------------------------------------------------------------------
// Stage durations (h): G1a 24 dean, K1 24 dept, L1 10 dept, N1 6 provost,
// N2 18 sponsored, Q1 0 research, R1 1 dept (completes 12-01T00:00, December),
// V1 1 dept (sub-ms digits truncated), W1 5 dept, Z2 24 dean.
// Excluded: G2a orphaned (G2 completed), W2 in progress, L2/X1 cancelled, Z1 skipped.
// Terminal: G1, G2 completed_status; M untracked; L decisive L2 cancelled
// (terminal_stage_invalid, no fallback to L1); K decided 11-19 before
// creation 11-20; included N 24 h (rejected), Q 0 h, V 1 h, Z 24 h, R 1 h (December).

const SX_WORKLOAD = {
  inScope: 2,
  included: 1,
  exclusions: { orphaned_active_stage: 1 },
  queues: { [DEAN]: 1 },
  pending_without_stage: { count: 3, inScope: 3 }, // S, U, Y
};
const SX_SPT_POP = {
  inScope: 15,
  included: 10,
  exclusions: { orphaned_active_stage: 1, in_progress_stage: 1, skipped_or_cancelled_stage: 3 },
};
const SX_TERMINAL_POP = {
  inScope: 10,
  included: 5,
  exclusions: {
    completed_status: 2,
    untracked_terminal_request: 1,
    terminal_stage_invalid: 1,
    decision_before_creation: 1,
  },
};
const SX_THROUGHPUT_POP = {
  inScope: 13,
  included: 10,
  exclusions: { skipped_or_cancelled_stage: 3 },
};

const sxNov: Expected = {
  request_volume: { value: 13, inScope: 15, included: 15 }, // all but S (December) and U (October)
  active_queue_workload: SX_WORKLOAD,
  stage_processing_time_average: {
    ...SX_SPT_POP,
    overall: { n: 9, value: (24 + 24 + 10 + 6 + 18 + 0 + 1 + 5 + 24) / 9 },
    queues: {
      [DEPT]: { n: 4, value: (24 + 10 + 1 + 5) / 4 },
      [DEAN]: { n: 2, value: 24 },
      [PROV]: { n: 1, value: 6 },
      [SPON]: { n: 1, value: 18 },
      [RES]: { n: 1, value: 0 },
    },
  },
  stage_processing_time_median: {
    ...SX_SPT_POP,
    overall: { n: 9, value: 10 }, // sorted 0, 1, 5, 6, 10, 18, 24, 24, 24
    queues: {
      [DEPT]: { n: 4, value: (5 + 10) / 2 },
      [DEAN]: { n: 2, value: 24 },
      [PROV]: { n: 1, value: 6 },
      [SPON]: { n: 1, value: 18 },
      [RES]: { n: 1, value: 0 },
    },
  },
  request_turnaround_time_average: { ...SX_TERMINAL_POP, n: 4, value: (24 + 0 + 1 + 24) / 4 },
  request_turnaround_time_median: { ...SX_TERMINAL_POP, n: 4, value: (1 + 24) / 2 },
  approval_rate: { ...SX_TERMINAL_POP, approved: 3, rejected: 1, value: 3 / 4 },
  queue_throughput: {
    ...SX_THROUGHPUT_POP,
    overall: 9,
    queues: { [DEPT]: 4, [DEAN]: 2, [PROV]: 1, [SPON]: 1, [RES]: 1 },
  },
};
const sxDec: Expected = {
  request_volume: { value: 1, inScope: 15, included: 15 }, // S at exactly 12-01T00:00Z
  active_queue_workload: SX_WORKLOAD,
  stage_processing_time_average: {
    ...SX_SPT_POP,
    overall: { n: 1, value: 1 },
    queues: { [DEPT]: { n: 1, value: 1 } },
  },
  stage_processing_time_median: {
    ...SX_SPT_POP,
    overall: { n: 1, value: 1 },
    queues: { [DEPT]: { n: 1, value: 1 } },
  },
  request_turnaround_time_average: { ...SX_TERMINAL_POP, n: 1, value: 1 },
  request_turnaround_time_median: { ...SX_TERMINAL_POP, n: 1, value: 1 },
  approval_rate: { ...SX_TERMINAL_POP, approved: 1, rejected: 0, value: 1 },
  queue_throughput: { ...SX_THROUGHPUT_POP, overall: 1, queues: { [DEPT]: 1 } },
};
const sxOct: Expected = {
  request_volume: { value: 1, inScope: 15, included: 15 }, // U at 10-31T23:59:59.999999Z (truncated to .999)
  active_queue_workload: SX_WORKLOAD,
  stage_processing_time_average: { ...SX_SPT_POP, ...noStages },
  stage_processing_time_median: { ...SX_SPT_POP, ...noStages },
  request_turnaround_time_average: { ...SX_TERMINAL_POP, n: 0, value: "no-data" },
  request_turnaround_time_median: { ...SX_TERMINAL_POP, n: 0, value: "no-data" },
  approval_rate: { ...SX_TERMINAL_POP, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { ...SX_THROUGHPUT_POP, overall: 0 },
};

// ---------------------------------------------------------------------------
// TypeScript-only scenarios
// ---------------------------------------------------------------------------

const S5 = dbRows("S5");

/** T-U1: spec 5.3 / 5.6 unknown queue U1 (procurement, 24 h) added on an October request. */
const tU1 = {
  requests: [
    ...S5.requests,
    req("00000000-0000-4000-a000-0000000000f1", "submitted", "2026-10-15T00:00:00Z"),
  ],
  stages: [
    ...S5.stages,
    stg(
      "00000000-0000-4000-b000-0000000000f1",
      "00000000-0000-4000-a000-0000000000f1",
      1,
      1,
      "procurement",
      "completed",
      "2026-11-16T00:00:00Z",
      "2026-11-17T00:00:00Z",
    ),
  ],
};
const tU1Pop = {
  inScope: 7,
  included: 5,
  exclusions: { orphaned_active_stage: 1, in_progress_stage: 1 },
  flags: { unknown_queue: 1 },
};
const tU1Nov: Expected = {
  ...s5Nov,
  request_volume: { value: 5, inScope: 7, included: 7 },
  stage_processing_time_average: {
    ...tU1Pop,
    overall: { n: 5, value: (12 + 24 + 48 + 48 + 60) / 5 },
    queues: { [DEPT]: { n: 3, value: 36 }, [DEAN]: { n: 1, value: 60 } },
    unknown: { n: 1, value: 24 },
  },
  stage_processing_time_median: {
    ...tU1Pop,
    overall: { n: 5, value: 48 },
    queues: { [DEPT]: { n: 3, value: 48 }, [DEAN]: { n: 1, value: 60 } },
    unknown: { n: 1, value: 24 },
  },
  queue_throughput: {
    inScope: 5,
    included: 5,
    flags: { unknown_queue: 1 },
    overall: 5,
    queues: { [DEPT]: 3, [DEAN]: 1 },
    unknown: 1,
  },
};

/** T-R: spec 5.2 second snapshot (R1, R2 dept; R3 dean; R5 two research rows; R6 procurement). */
const R = (n: number) => `00000000-0000-4000-a000-0000000002${String(n).padStart(2, "0")}`;
const RS = (n: number) => `00000000-0000-4000-b000-0000000002${String(n).padStart(2, "0")}`;
const tR = {
  requests: [1, 2, 3, 5, 6].map((n) => req(R(n), "submitted", "2026-11-20T00:00:00Z")),
  stages: [
    stg(RS(1), R(1), 1, 1, DEPT, "active", "2026-11-20T01:00:00Z", null),
    stg(RS(2), R(2), 1, 1, DEPT, "active", "2026-11-20T01:00:00Z", null),
    stg(RS(3), R(3), 1, 1, DEAN, "active", "2026-11-20T01:00:00Z", null),
    stg(RS(5), R(5), 1, 1, RES, "active", "2026-11-20T01:00:00Z", null),
    stg(RS(51), R(5), 1, 2, RES, "active", "2026-11-20T01:00:00Z", null),
    stg(RS(6), R(6), 1, 1, "procurement", "active", "2026-11-20T01:00:00Z", null),
  ],
};
const tRNov: Expected = {
  request_volume: { value: 5, inScope: 5, included: 5 },
  active_queue_workload: {
    inScope: 6,
    included: 6,
    flags: { duplicate_active_stages: 1, unknown_queue: 1 },
    queues: { [DEPT]: 2, [DEAN]: 1, [RES]: 1 },
    unknown: 1,
    pending_without_stage: { count: 0, inScope: 0 },
  },
  stage_processing_time_average: {
    inScope: 6,
    included: 0,
    exclusions: { in_progress_stage: 6 },
    ...noStages,
  },
  stage_processing_time_median: {
    inScope: 6,
    included: 0,
    exclusions: { in_progress_stage: 6 },
    ...noStages,
  },
  request_turnaround_time_average: { inScope: 0, included: 0, n: 0, value: "no-data" },
  request_turnaround_time_median: { inScope: 0, included: 0, n: 0, value: "no-data" },
  approval_rate: { inScope: 0, included: 0, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { inScope: 0, included: 0, overall: 0 },
};

/**
 * T-W: workload extension. W1 active in two queues; W2 two active rows in one
 * queue; W3 dept; W4 rejected with an active stage (orphan); W5 pending with
 * only a cancelled stage (not pending_without_stage); W6 pending, no stages;
 * W7 queue 'Dean_Office' (case differs: unknown).
 */
const W = (n: number) => `00000000-0000-4000-a000-0000000003${String(n).padStart(2, "0")}`;
const WS = (n: number) => `00000000-0000-4000-b000-0000000003${String(n).padStart(2, "0")}`;
const tW = {
  requests: [
    req(W(1), "submitted", "2026-11-20T00:00:00Z"),
    req(W(2), "submitted", "2026-11-20T00:00:00Z"),
    req(W(3), "under_review", "2026-11-20T00:00:00Z"),
    req(W(4), "rejected", "2026-11-20T00:00:00Z"),
    req(W(5), "submitted", "2026-11-20T00:00:00Z"),
    req(W(6), "under_review", "2026-11-20T00:00:00Z"),
    req(W(7), "submitted", "2026-11-20T00:00:00Z"),
  ],
  stages: [
    stg(WS(11), W(1), 1, 1, DEPT, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(12), W(1), 1, 2, CFO, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(21), W(2), 1, 1, RES, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(22), W(2), 1, 2, RES, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(31), W(3), 1, 1, DEPT, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(41), W(4), 1, 1, DEAN, "active", "2026-11-20T00:00:00Z", null),
    stg(WS(51), W(5), 1, 1, DEPT, "cancelled", "2026-11-20T00:00:00Z", "2026-11-20T01:00:00Z"),
    stg(WS(71), W(7), 1, 1, "Dean_Office", "active", "2026-11-20T00:00:00Z", null),
  ],
};
const tWNov: Expected = {
  request_volume: { value: 7, inScope: 7, included: 7 },
  active_queue_workload: {
    inScope: 7,
    included: 6,
    exclusions: { orphaned_active_stage: 1 },
    flags: { duplicate_active_stages: 2, unknown_queue: 1 },
    queues: { [DEPT]: 2, [CFO]: 1, [RES]: 1 },
    unknown: 1,
    pending_without_stage: { count: 1, inScope: 1 },
  },
  stage_processing_time_average: {
    inScope: 8,
    included: 0,
    exclusions: { orphaned_active_stage: 1, in_progress_stage: 6, skipped_or_cancelled_stage: 1 },
    ...noStages,
  },
  stage_processing_time_median: {
    inScope: 8,
    included: 0,
    exclusions: { orphaned_active_stage: 1, in_progress_stage: 6, skipped_or_cancelled_stage: 1 },
    ...noStages,
  },
  request_turnaround_time_average: {
    inScope: 1,
    included: 0,
    exclusions: { terminal_request_with_active_stage: 1 },
    n: 0,
    value: "no-data",
  },
  request_turnaround_time_median: {
    inScope: 1,
    included: 0,
    exclusions: { terminal_request_with_active_stage: 1 },
    n: 0,
    value: "no-data",
  },
  approval_rate: {
    inScope: 1,
    included: 0,
    exclusions: { terminal_request_with_active_stage: 1 },
    approved: 0,
    rejected: 0,
    value: "no-data",
  },
  queue_throughput: {
    inScope: 1,
    included: 0,
    exclusions: { skipped_or_cancelled_stage: 1 },
    overall: 0,
  },
};

/**
 * T-D: decisive-stage edges, all created 2026-11-01T00:00Z, approved except D8.
 * D1 tie at the highest pair (1,2); D2 tie at the lower pair (1,1) with a
 * unique highest (2,1): valid, 96 h; D3 revision 10 beats 9 (integers, not
 * text): 72 h; D4 null revision on a lower stage; D5 stage_order 1.5; D6
 * stage_order "2" (a string); D7 decisive completed_at unparseable;
 * D8 rejected, decisive (1,2): 120 h.
 */
const D = (n: number) => `00000000-0000-4000-a000-0000000004${String(n).padStart(2, "0")}`;
const DS = (n: number, s: string) =>
  `00000000-0000-4000-b000-0000000004${n}${s === "a" ? 1 : s === "b" ? 2 : 3}`;
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}T00:00:00Z`;
const tD = {
  requests: [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    req(D(n), n === 8 ? "rejected" : "approved", day(1)),
  ),
  stages: [
    stg(DS(1, "a"), D(1), 1, 1, DEPT, "completed", day(1), day(2)),
    stg(DS(1, "b"), D(1), 1, 2, DEAN, "completed", day(2), day(3)),
    stg(DS(1, "c"), D(1), 1, 2, CFO, "completed", day(2), day(3)),
    stg(DS(2, "a"), D(2), 1, 1, DEPT, "completed", day(1), day(2)),
    stg(DS(2, "b"), D(2), 1, 1, DEAN, "completed", day(1), day(2)),
    stg(DS(2, "c"), D(2), 2, 1, PROV, "completed", day(4), day(5)),
    stg(DS(3, "a"), D(3), 9, 5, DEPT, "completed", day(2), day(3)),
    stg(DS(3, "b"), D(3), 10, 1, DEAN, "completed", day(3), day(4)),
    stg(DS(4, "a"), D(4), null, 1, DEPT, "completed", day(1), day(2)),
    stg(DS(4, "b"), D(4), 2, 1, DEAN, "completed", day(2), day(3)),
    stg(DS(5, "a"), D(5), 1, 1.5, DEPT, "completed", day(1), day(2)),
    stg(DS(6, "a"), D(6), 1, "2", DEPT, "completed", day(1), day(2)),
    stg(DS(7, "a"), D(7), 1, 1, DEPT, "completed", day(1), "not-a-date"),
    stg(DS(8, "a"), D(8), 1, 1, DEPT, "completed", day(1), day(3)),
    stg(DS(8, "b"), D(8), 1, 2, DEAN, "completed", day(3), day(6)),
  ],
};
const tDSpt = { inScope: 15, included: 14, exclusions: { invalid_stage_timestamps: 1 } };
const tDTerm = { inScope: 8, included: 3, exclusions: { terminal_stage_invalid: 5 } };
const tDNov: Expected = {
  request_volume: { value: 8, inScope: 8, included: 8 }, // created exactly at the period start
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    ...tDSpt,
    overall: { n: 14, value: (12 * 24 + 48 + 72) / 14 },
    queues: {
      [DEPT]: { n: 7, value: (6 * 24 + 48) / 7 },
      [DEAN]: { n: 5, value: (4 * 24 + 72) / 5 },
      [CFO]: { n: 1, value: 24 },
      [PROV]: { n: 1, value: 24 },
    },
  },
  stage_processing_time_median: {
    ...tDSpt,
    overall: { n: 14, value: 24 },
    queues: {
      [DEPT]: { n: 7, value: 24 },
      [DEAN]: { n: 5, value: 24 },
      [CFO]: { n: 1, value: 24 },
      [PROV]: { n: 1, value: 24 },
    },
  },
  request_turnaround_time_average: { ...tDTerm, n: 3, value: (96 + 72 + 120) / 3 },
  request_turnaround_time_median: { ...tDTerm, n: 3, value: 96 },
  approval_rate: { ...tDTerm, approved: 2, rejected: 1, value: 2 / 3 },
  queue_throughput: {
    ...tDSpt,
    overall: 14,
    queues: { [DEPT]: 7, [DEAN]: 5, [CFO]: 1, [PROV]: 1 },
  },
};

/**
 * T-TS: timestamp validity, precision, offsets and boundaries. All requests
 * pending; all stages on a1. Volume: a1 at the period start (inclusive), a2
 * at the period end (exclusive), a3 at 23:59:59.9999 (truncated to .999,
 * November), a4 20:00-05:00 (= 12-01T01:00Z), a5 00:30+01:00 (= 10-31T23:30Z);
 * a6-a12 invalid (date-only, space separator, garbage, null, lowercase z, no
 * offset, 30 February).
 */
const A = (n: number) => `00000000-0000-4000-a000-0000000005${String(n).padStart(2, "0")}`;
const AS = (n: number) => `00000000-0000-4000-b000-0000000005${String(n).padStart(2, "0")}`;
const tTS = {
  requests: [
    req(A(1), "submitted", "2026-11-01T00:00:00Z"),
    req(A(2), "submitted", "2026-12-01T00:00:00Z"),
    req(A(3), "submitted", "2026-11-30T23:59:59.9999+00:00"),
    req(A(4), "submitted", "2026-11-30T20:00:00-05:00"),
    req(A(5), "submitted", "2026-11-01T00:30:00+01:00"),
    req(A(6), "submitted", "2026-11-15"),
    req(A(7), "submitted", "2026-11-15 10:00:00+00"),
    req(A(8), "submitted", "not-a-date"),
    req(A(9), "submitted", null),
    req(A(10), "submitted", "2026-11-15T10:00:00z"),
    req(A(11), "submitted", "2026-11-15T10:00:00"),
    req(A(12), "submitted", "2026-02-30T00:00:00Z"),
  ],
  stages: [
    stg(AS(1), A(1), 1, 1, DEPT, "completed", "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z"), // 0 h
    stg(AS(2), A(1), 1, 2, DEPT, "completed", "2026-11-10T05:00:00Z", "2026-11-10T04:00:00Z"), // end before start
    stg(
      AS(3),
      A(1),
      1,
      3,
      DEPT,
      "completed",
      "2026-11-10T00:00:00.000999+00:00",
      "2026-11-10T00:00:00.000001+00:00",
    ), // same ms: 0 h
    stg(AS(4), A(1), 1, 4, DEPT, "completed", null, "2026-11-10T00:00:00Z"), // invalid start
    stg(AS(5), A(1), 1, 5, DEPT, "completed", "2026-11-10T00:00:00Z", null), // missing completed_at
    stg(AS(6), A(1), 1, 6, DEPT, "done", "2026-11-10T00:00:00Z", "2026-11-10T01:00:00Z"), // unrecognized
    stg(AS(7), A(1), 1, 7, DEPT, null, "2026-11-10T00:00:00Z", "2026-11-10T01:00:00Z"), // null status: unrecognized
    stg(AS(8), A(1), 1, 8, DEPT, "skipped", "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z"),
    stg(
      AS(9),
      A(1),
      1,
      9,
      PROV,
      "completed",
      "2026-11-10T00:00:00-05:00",
      "2026-11-10T08:30:00+02:00",
    ), // 05:00Z -> 06:30Z = 1.5 h
    stg(AS(10), A(1), 1, 10, DEPT, "completed", "2026-11-30T22:00:00Z", "2026-12-01T00:00:00Z"), // 2 h, December
    stg(AS(11), A(1), 1, 11, DEPT, "completed", "2026-10-31T23:00:00Z", "2026-11-01T00:00:00Z"), // 1 h, November
    stg(
      AS(12),
      A(1),
      1,
      12,
      DEPT,
      "completed",
      "2026-11-30T23:00:00Z",
      "2026-11-30T23:59:59.9999+00:00",
    ), // 3,599,999 ms
    stg(AS(13), A(1), 1, 13, DEPT, "completed", "2026-11-10T00:00:00Z", "2026-11-11"), // date-only end
    stg(AS(14), A(1), 1, 14, DEPT, "active", "2026-11-10T00:00:00Z", null),
  ],
};
const H12 = 3_599_999 / 3_600_000;
const tTSSpt = {
  inScope: 14,
  included: 6,
  exclusions: {
    in_progress_stage: 1,
    skipped_or_cancelled_stage: 1,
    unrecognized_stage_status: 2,
    stage_missing_completed_at: 1,
    invalid_stage_timestamps: 3,
  },
};
const tTSThr = {
  inScope: 13,
  included: 6,
  exclusions: {
    skipped_or_cancelled_stage: 1,
    unrecognized_stage_status: 2,
    stage_missing_completed_at: 1,
    invalid_stage_timestamps: 3,
  },
};
const tTSBase = (volume: number) => ({
  request_volume: {
    value: volume,
    inScope: 12,
    included: 5,
    exclusions: { invalid_created_at: 7 },
  },
  active_queue_workload: {
    inScope: 1,
    included: 1,
    queues: { [DEPT]: 1 },
    pending_without_stage: { count: 11, inScope: 11 },
  },
  request_turnaround_time_average: { inScope: 0, included: 0, n: 0, value: "no-data" as const },
  request_turnaround_time_median: { inScope: 0, included: 0, n: 0, value: "no-data" as const },
  approval_rate: { inScope: 0, included: 0, approved: 0, rejected: 0, value: "no-data" as const },
});
const tTSNov: Expected = {
  ...tTSBase(2), // a1, a3
  stage_processing_time_average: {
    ...tTSSpt,
    overall: { n: 5, value: (0 + 0 + 1 + H12 + 1.5) / 5 },
    queues: { [DEPT]: { n: 4, value: (0 + 0 + 1 + H12) / 4 }, [PROV]: { n: 1, value: 1.5 } },
  },
  stage_processing_time_median: {
    ...tTSSpt,
    overall: { n: 5, value: H12 }, // sorted 0, 0, H12, 1, 1.5
    queues: { [DEPT]: { n: 4, value: (0 + H12) / 2 }, [PROV]: { n: 1, value: 1.5 } },
  },
  queue_throughput: { ...tTSThr, overall: 5, queues: { [DEPT]: 4, [PROV]: 1 } },
};
const tTSDec: Expected = {
  ...tTSBase(2), // a2, a4
  stage_processing_time_average: {
    ...tTSSpt,
    overall: { n: 1, value: 2 },
    queues: { [DEPT]: { n: 1, value: 2 } },
  },
  stage_processing_time_median: {
    ...tTSSpt,
    overall: { n: 1, value: 2 },
    queues: { [DEPT]: { n: 1, value: 2 } },
  },
  queue_throughput: { ...tTSThr, overall: 1, queues: { [DEPT]: 1 } },
};
const tTSOct: Expected = {
  ...tTSBase(1), // a5
  stage_processing_time_average: { ...tTSSpt, ...noStages },
  stage_processing_time_median: { ...tTSSpt, ...noStages },
  queue_throughput: { ...tTSThr, overall: 0 },
};
/** Eastern custom range 2026-10-31 = [10-31T04:00Z, 11-01T04:00Z): a1 (11-01T00Z), a5 (10-31T23:30Z); s11 (11-01T00Z). */
const tTSEastern: Expected = {
  ...tTSBase(2),
  stage_processing_time_average: {
    ...tTSSpt,
    overall: { n: 1, value: 1 },
    queues: { [DEPT]: { n: 1, value: 1 } },
  },
  stage_processing_time_median: {
    ...tTSSpt,
    overall: { n: 1, value: 1 },
    queues: { [DEPT]: { n: 1, value: 1 } },
  },
  queue_throughput: { ...tTSThr, overall: 1, queues: { [DEPT]: 1 } },
};

/**
 * T-TAT: decision instants with different offsets and sub-millisecond digits.
 * b1 created 07:00+02:00 (05:00Z), decided 00:00-05:00 (05:00Z): 0 h.
 * b2 created 12:00Z, decided 06:59:59.9999-05:00 (11:59:59.999Z): 1 ms early,
 *    decision_before_creation.
 * b3 rejected, created 12:00:00.0009Z, decided 12:00:00.0001Z: same ms, 0 h.
 * b4 created 11-20T00Z, decided 11-21T06:00+06:00 (11-21T00Z): 24 h.
 */
const B = (n: number) => `00000000-0000-4000-a000-0000000006${String(n).padStart(2, "0")}`;
const BS = (n: number) => `00000000-0000-4000-b000-0000000006${String(n).padStart(2, "0")}`;
const tTAT = {
  requests: [
    req(B(1), "approved", "2026-11-10T07:00:00+02:00"),
    req(B(2), "approved", "2026-11-10T12:00:00Z"),
    req(B(3), "rejected", "2026-11-10T12:00:00.0009Z"),
    req(B(4), "approved", "2026-11-20T00:00:00Z"),
  ],
  stages: [
    stg(BS(1), B(1), 1, 1, DEPT, "completed", "2026-11-10T04:00:00Z", "2026-11-10T00:00:00-05:00"), // 1 h
    stg(
      BS(2),
      B(2),
      1,
      1,
      DEPT,
      "completed",
      "2026-11-10T10:00:00Z",
      "2026-11-10T06:59:59.9999-05:00",
    ), // 7,199,999 ms
    stg(
      BS(3),
      B(3),
      1,
      1,
      DEPT,
      "completed",
      "2026-11-10T12:00:00.0001Z",
      "2026-11-10T12:00:00.0001Z",
    ), // 0 h
    stg(BS(4), B(4), 1, 1, DEAN, "completed", "2026-11-20T00:00:00Z", "2026-11-21T06:00:00+06:00"), // 24 h
  ],
};
const H_B2 = 7_199_999 / 3_600_000;
const tTATTerm = { inScope: 4, included: 3, exclusions: { decision_before_creation: 1 } };
const tTATNov: Expected = {
  request_volume: { value: 4, inScope: 4, included: 4 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    inScope: 4,
    included: 4,
    overall: { n: 4, value: (1 + H_B2 + 0 + 24) / 4 },
    queues: { [DEPT]: { n: 3, value: (1 + H_B2 + 0) / 3 }, [DEAN]: { n: 1, value: 24 } },
  },
  stage_processing_time_median: {
    inScope: 4,
    included: 4,
    overall: { n: 4, value: (1 + H_B2) / 2 },
    queues: { [DEPT]: { n: 3, value: 1 }, [DEAN]: { n: 1, value: 24 } },
  },
  request_turnaround_time_average: { ...tTATTerm, n: 3, value: (0 + 0 + 24) / 3 },
  request_turnaround_time_median: { ...tTATTerm, n: 3, value: 0 },
  approval_rate: { ...tTATTerm, approved: 2, rejected: 1, value: 2 / 3 },
  queue_throughput: { inScope: 4, included: 4, overall: 4, queues: { [DEPT]: 3, [DEAN]: 1 } },
};

/**
 * T-DS: the decisive stage completes in a different period than an earlier
 * stage. The decision period is the decisive stage's, never the first stage's.
 * k1 approved, created 10-20T00Z:
 *    ks1 rev 1, order 1, dept, 10-20T00Z -> 10-25T00Z = 120 h (completed in October);
 *    ks2 rev 1, order 2, dean, 10-25T00Z -> 11-03T00Z = 216 h (decisive, November).
 *    T(k1) = 11-03T00Z; TAT = 10-20T00Z -> 11-03T00Z = 14 d = 336 h.
 * k2 rejected, created 10-26T00Z:
 *    ks3 rev 1, order 1, dept, 10-26T00Z -> 10-27T00Z = 24 h (completed in October);
 *    ks4 rev 2, order 1, provost, 10-28T00Z -> 11-02T12Z = 5 d 12 h = 132 h
 *    (decisive by revision, November).
 *    T(k2) = 11-02T12Z; TAT = 10-26T00Z -> 11-02T12Z = 7 d 12 h = 180 h.
 * Both requests are decided in November, so October has no decisions. Stage
 * metrics follow each stage's own completed_at: October has ks1 and ks3,
 * November has ks2 and ks4. Both requests are created in October.
 */
const K = (n: number) => `00000000-0000-4000-a000-0000000009${String(n).padStart(2, "0")}`;
const KS = (n: number) => `00000000-0000-4000-b000-0000000009${String(n).padStart(2, "0")}`;
const tDS = {
  requests: [
    req(K(1), "approved", "2026-10-20T00:00:00Z"),
    req(K(2), "rejected", "2026-10-26T00:00:00Z"),
  ],
  stages: [
    stg(KS(1), K(1), 1, 1, DEPT, "completed", "2026-10-20T00:00:00Z", "2026-10-25T00:00:00Z"), // 120 h
    stg(KS(2), K(1), 1, 2, DEAN, "completed", "2026-10-25T00:00:00Z", "2026-11-03T00:00:00Z"), // 216 h
    stg(KS(3), K(2), 1, 1, DEPT, "completed", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z"), // 24 h
    stg(KS(4), K(2), 2, 1, PROV, "completed", "2026-10-28T00:00:00Z", "2026-11-02T12:00:00Z"), // 132 h
  ],
};
const tDSTerm = { inScope: 2, included: 2 };
const tDSStages = { inScope: 4, included: 4 };
const tDSOct: Expected = {
  request_volume: { value: 2, inScope: 2, included: 2 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    ...tDSStages,
    overall: { n: 2, value: (120 + 24) / 2 },
    queues: { [DEPT]: { n: 2, value: (120 + 24) / 2 } },
  },
  stage_processing_time_median: {
    ...tDSStages,
    overall: { n: 2, value: (24 + 120) / 2 },
    queues: { [DEPT]: { n: 2, value: (24 + 120) / 2 } },
  },
  request_turnaround_time_average: { ...tDSTerm, n: 0, value: "no-data" },
  request_turnaround_time_median: { ...tDSTerm, n: 0, value: "no-data" },
  approval_rate: { ...tDSTerm, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { ...tDSStages, overall: 2, queues: { [DEPT]: 2 } },
};
const tDSNov: Expected = {
  request_volume: { value: 0, inScope: 2, included: 2 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    ...tDSStages,
    overall: { n: 2, value: (216 + 132) / 2 },
    queues: { [DEAN]: { n: 1, value: 216 }, [PROV]: { n: 1, value: 132 } },
  },
  stage_processing_time_median: {
    ...tDSStages,
    overall: { n: 2, value: (132 + 216) / 2 },
    queues: { [DEAN]: { n: 1, value: 216 }, [PROV]: { n: 1, value: 132 } },
  },
  request_turnaround_time_average: { ...tDSTerm, n: 2, value: (336 + 180) / 2 },
  request_turnaround_time_median: { ...tDSTerm, n: 2, value: (180 + 336) / 2 },
  approval_rate: { ...tDSTerm, approved: 1, rejected: 1, value: 1 / 2 },
  queue_throughput: { ...tDSStages, overall: 2, queues: { [DEAN]: 1, [PROV]: 1 } },
};

/** T-P: section 5 plus browser prototypes P1 (submitted), P2 (approved), P3 (submitted, unparseable created_at). */
export const PROTOTYPES: EfficiencyRequestRow[] = [
  req("proto-1", "submitted", "2026-11-05T10:00:00Z"),
  req("proto-2", "approved", "2026-11-06T00:00:00Z"),
  req("proto-3", "submitted", "garbage"),
] as unknown as EfficiencyRequestRow[];
const tPTerm = {
  inScope: 5,
  included: 3,
  exclusions: { prototype_request: 1, terminal_request_with_active_stage: 1 },
};
const tPNov: Expected = {
  ...s5Nov,
  request_volume: { value: 5, inScope: 9, included: 6, exclusions: { prototype_request: 3 } },
  active_queue_workload: {
    ...S5_WORKLOAD,
    pending_without_stage: { count: 1, inScope: 3, exclusions: { prototype_request: 2 } },
  },
  request_turnaround_time_average: { ...tPTerm, n: 3, value: (TAT_A + TAT_B + TAT_D) / 3 },
  request_turnaround_time_median: { ...tPTerm, n: 3, value: TAT_D },
  approval_rate: { ...tPTerm, approved: 2, rejected: 1, value: 2 / 3 },
};

/** T-EMPTY: a complete, valid, empty dataset. */
const tEmptyNov: Expected = {
  request_volume: { value: 0, inScope: 0, included: 0 },
  active_queue_workload: workloadNone,
  stage_processing_time_average: { inScope: 0, included: 0, ...noStages },
  stage_processing_time_median: { inScope: 0, included: 0, ...noStages },
  request_turnaround_time_average: { inScope: 0, included: 0, n: 0, value: "no-data" },
  request_turnaround_time_median: { inScope: 0, included: 0, n: 0, value: "no-data" },
  approval_rate: { inScope: 0, included: 0, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: { inScope: 0, included: 0, overall: 0 },
};

/** T-ALLEXCL: every in-scope record excluded; Request Volume is a valid 0, statistics are no-data. */
const tAll = {
  requests: [
    req("00000000-0000-4000-a000-000000000701", "approved", "bad"),
    req("00000000-0000-4000-a000-000000000702", "completed", "2026-11-02"),
  ],
  stages: [
    stg(
      "00000000-0000-4000-b000-000000000702",
      "00000000-0000-4000-a000-000000000702",
      1,
      1,
      DEPT,
      "cancelled",
      "2026-11-02T00:00:00Z",
      "2026-11-03T00:00:00Z",
    ),
  ],
};
const tAllTerm = {
  inScope: 2,
  included: 0,
  exclusions: { completed_status: 1, invalid_created_at: 1 },
};
const tAllNov: Expected = {
  request_volume: { value: 0, inScope: 2, included: 0, exclusions: { invalid_created_at: 2 } },
  active_queue_workload: workloadNone,
  stage_processing_time_average: {
    inScope: 1,
    included: 0,
    exclusions: { skipped_or_cancelled_stage: 1 },
    ...noStages,
  },
  stage_processing_time_median: {
    inScope: 1,
    included: 0,
    exclusions: { skipped_or_cancelled_stage: 1 },
    ...noStages,
  },
  request_turnaround_time_average: { ...tAllTerm, n: 0, value: "no-data" },
  request_turnaround_time_median: { ...tAllTerm, n: 0, value: "no-data" },
  approval_rate: { ...tAllTerm, approved: 0, rejected: 0, value: "no-data" },
  queue_throughput: {
    inScope: 1,
    included: 0,
    exclusions: { skipped_or_cancelled_stage: 1 },
    overall: 0,
  },
};

// ---------------------------------------------------------------------------
// Load-integrity scenarios (section 3.3, 5.7, 8.3 gating) on the S5 rows
// ---------------------------------------------------------------------------

const blocked = (errors: string[], issue: "access" | "unavailable" | null = null) => ({
  status: "blocked" as const,
  errors,
  issue,
});
const ALL_BUT = (
  keep: Partial<Expected>,
  errors: string[],
  issue: "access" | "unavailable" | null = null,
): Expected => ({
  request_volume: keep.request_volume ?? blocked(errors, issue),
  active_queue_workload: keep.active_queue_workload ?? blocked(errors, issue),
  stage_processing_time_average: keep.stage_processing_time_average ?? blocked(errors, issue),
  stage_processing_time_median: keep.stage_processing_time_median ?? blocked(errors, issue),
  request_turnaround_time_average: keep.request_turnaround_time_average ?? blocked(errors, issue),
  request_turnaround_time_median: keep.request_turnaround_time_median ?? blocked(errors, issue),
  approval_rate: keep.approval_rate ?? blocked(errors, issue),
  queue_throughput: keep.queue_throughput ?? blocked(errors, issue),
});
const s5Tables = (
  requests: Partial<TableSpec> = {},
  stages: Partial<TableSpec> = {},
): LoadSpec => ({
  requests: { rows: S5.requests, ...requests },
  stages: { rows: S5.stages, ...stages },
});
const ORPHAN_STAGE = stg(
  "00000000-0000-4000-b000-000000000899",
  "00000000-0000-4000-a000-000000000099",
  1,
  1,
  DEAN,
  "completed",
  "2026-11-20T00:00:00Z",
  "2026-11-21T00:00:00Z",
);

// ---------------------------------------------------------------------------
// The scenario list
// ---------------------------------------------------------------------------

export type Scenario = {
  readonly id: string;
  readonly description: string;
  readonly load: LoadSpec;
  readonly prototypes?: readonly EfficiencyRequestRow[];
  readonly expected: Partial<Record<PeriodKey, Expected>>;
  /** Database-backed scenarios: fixture key in fixtures/db-scenarios.json. */
  readonly db?: "S5" | "S58" | "SX";
  /** Extra checks the generic comparison does not cover. */
  readonly tags?: readonly string[];
};

const rows = (r: { requests: readonly object[]; stages: readonly object[] }): LoadSpec => ({
  requests: { rows: r.requests },
  stages: { rows: r.stages },
});

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "S5",
    db: "S5",
    description: "Spec section 5 worked example (A-F), November plus October and December.",
    load: rows(dbRows("S5")),
    expected: { nov: s5Nov, oct: s5Quiet(1), dec: s5Quiet(0) },
  },
  {
    id: "S58",
    db: "S58",
    description:
      "Spec section 5.8 amended request H (decisive stage in revision 2, cancelled stage).",
    load: rows(dbRows("S58")),
    expected: { nov: s58Nov, oct: s58Quiet, dec: s58Quiet },
  },
  {
    id: "SX",
    db: "SX",
    description:
      "Storable edges: completed status, orphan on completed request, decision before creation, cancelled decisive stage, untracked terminal, multi-queue rejection, 0 h, period boundaries, sub-ms digits, skipped stages.",
    load: rows(dbRows("SX")),
    expected: { nov: sxNov, oct: sxOct, dec: sxDec },
  },
  {
    id: "T-U1",
    description: "Spec 5.3 / 5.6 unknown queue U1 (procurement) added to section 5.",
    load: rows(tU1),
    expected: { nov: tU1Nov },
  },
  {
    id: "T-R",
    description: "Spec 5.2 second snapshot: duplicate active stages (R5) and unknown queue (R6).",
    load: rows(tR),
    expected: { nov: tRNov },
  },
  {
    id: "T-W",
    description:
      "Workload: one request in two queues, two rows in one queue, orphan, cancelled-only pending, case-variant queue id.",
    load: rows(tW),
    expected: { nov: tWNov },
    tags: ["queue-sum-vs-distinct"],
  },
  {
    id: "T-D",
    description:
      "Decisive stage: highest-pair tie, lower tie with unique highest, revision 10 vs 9, null / fractional / string keys, unparseable decision instant.",
    load: rows(tD),
    expected: { nov: tDNov },
  },
  {
    id: "T-TS",
    description:
      "Timestamp validity, sub-ms truncation, explicit offsets and half-open period boundaries.",
    load: rows(tTS),
    expected: { nov: tTSNov, oct: tTSOct, dec: tTSDec, eastern_2026_10_31: tTSEastern },
  },
  {
    id: "T-TAT",
    description:
      "Decision instants across offsets and sub-ms digits; 1 ms decision_before_creation.",
    load: rows(tTAT),
    expected: { nov: tTATNov },
  },
  {
    id: "T-DS",
    description:
      "Decisive stage completed in another period than an earlier stage: the decisive stage sets the decision period.",
    load: rows(tDS),
    expected: { oct: tDSOct, nov: tDSNov },
  },
  {
    id: "T-P",
    description: "Section 5 with browser prototypes (submitted, approved, unparseable created_at).",
    load: rows(dbRows("S5")),
    prototypes: PROTOTYPES,
    expected: { nov: tPNov },
  },
  {
    id: "T-EMPTY",
    description: "Complete, valid, empty dataset.",
    load: rows({ requests: [], stages: [] }),
    expected: { nov: tEmptyNov },
  },
  {
    id: "T-ALLEXCL",
    description: "Every in-scope record excluded: valid zero versus no-data.",
    load: rows(tAll),
    expected: { nov: tAllNov },
  },
  {
    id: "L-REQ-ACCESS",
    description: "Request read fails with a permission error (42501).",
    load: s5Tables({
      pageError: { code: "42501", message: "permission denied for table financial_requests" },
    }),
    expected: {
      nov: ALL_BUT({ queue_throughput: s5Nov.queue_throughput }, ["request_read_failed"], "access"),
    },
  },
  {
    id: "L-STAGE-UNAVAILABLE",
    description: "Stage read fails with a network error.",
    load: s5Tables({}, { pageError: { message: "fetch failed" } }),
    expected: {
      nov: ALL_BUT({ request_volume: s5Nov.request_volume }, ["stage_read_failed"], "unavailable"),
    },
  },
  {
    id: "L-STAGE-ROWCAP",
    description: "Stage read truncated by a row cap (4 of 6 rows): count mismatch (spec 5.7).",
    load: s5Tables({}, { rowCap: 4 }),
    expected: { nov: ALL_BUT({ request_volume: s5Nov.request_volume }, ["stage_read_incomplete"]) },
  },
  {
    id: "L-STAGE-ACTIVE-ONLY",
    description: "Stage read returns only active stages (spec 5.7 workload case).",
    load: s5Tables({}, { serve: (row) => row.status === "active" }),
    expected: { nov: ALL_BUT({ request_volume: s5Nov.request_volume }, ["stage_read_incomplete"]) },
  },
  {
    id: "L-STAGE-DUPLICATE-KEY",
    description: "Stage page repeats a row: duplicate key.",
    load: s5Tables({}, { duplicateFirst: true }),
    expected: { nov: ALL_BUT({ request_volume: s5Nov.request_volume }, ["stage_read_incomplete"]) },
  },
  {
    id: "L-REQ-FIELD",
    description: "Request read omits created_at (spec 5.7): request_field_missing.",
    load: s5Tables({ omitField: "created_at" }),
    expected: {
      nov: ALL_BUT({ queue_throughput: s5Nov.queue_throughput }, ["request_field_missing"]),
    },
  },
  {
    id: "L-STAGE-FIELD",
    description: "Stage read omits workflow_revision: stage_field_missing.",
    load: s5Tables({}, { omitField: "workflow_revision" }),
    expected: { nov: ALL_BUT({ request_volume: s5Nov.request_volume }, ["stage_field_missing"]) },
  },
  {
    id: "L-NOT-LOADED",
    description: "A stage whose request is not in the request read (spec 5.7).",
    load: s5Tables({}, { rows: [...S5.stages, ORPHAN_STAGE] }),
    expected: {
      nov: ALL_BUT(
        {
          request_volume: s5Nov.request_volume,
          queue_throughput: {
            inScope: 5,
            included: 5,
            overall: 5,
            queues: { [DEPT]: 3, [DEAN]: 2 },
          },
        },
        ["stage_request_not_loaded"],
      ),
    },
  },
  {
    id: "L-BOTH-FAILED",
    description: "Both reads fail; F19.3 classifies only the first failed read (requests).",
    load: s5Tables(
      { pageError: { code: "42501", message: "permission denied" } },
      { pageError: { message: "fetch failed" } },
    ),
    expected: {
      nov: ALL_BUT(
        {
          request_volume: blocked(["request_read_failed"], "access"),
          queue_throughput: blocked(["stage_read_failed"], null),
        },
        ["request_read_failed", "stage_read_failed"],
        "access",
      ),
    },
  },
  {
    id: "L-CANCELLED",
    description: "The load is cancelled before it starts.",
    load: { ...s5Tables(), aborted: true },
    expected: {
      nov: Object.fromEntries(
        Object.keys(s5Nov).map((k) => [k, { status: "cancelled" }]),
      ) as unknown as Expected,
    },
  },
];
