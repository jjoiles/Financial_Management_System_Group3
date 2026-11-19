import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EfficiencyRequestRow, EfficiencyStageRow } from "./efficiency-data";
import {
  DATA_QUALITY_CHECKS,
  EFFICIENCY_METRICS,
  EFFICIENCY_METRIC_IDS,
  type DataQualityCode,
  type EfficiencyMetricId,
  type MetricPopulation,
} from "./efficiency-metrics";
import {
  POPULATION_SCOPES,
  REQUEST_CONDITION_PREDICATES,
  REQUEST_FLAG_RULES,
  SEPARATE_REPORT_SCOPES,
  STAGE_CONDITION_PREDICATES,
  STAGE_FLAG_RULES,
  classifyMetricPopulation,
  classifyRecords,
  decisionInstant,
  type MetricClassification,
  type RequestCandidate,
  type StageCandidate,
  type SubjectPopulationResult,
} from "./efficiency-classification";
import { indexDataset, type DatasetIndex } from "./efficiency-population";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T = (value: string) => `2026-${value}+00:00`;

function request(
  id: string,
  status: EfficiencyRequestRow["status"],
  createdAt: string,
): EfficiencyRequestRow {
  return { id, status, created_at: T(createdAt) };
}

function stage(
  id: string,
  requestId: string,
  fields: Partial<EfficiencyStageRow> & { started?: string; completed?: string | null },
): EfficiencyStageRow {
  const { started = "11-01T00:00:00", completed = "11-02T00:00:00", ...rest } = fields;
  return {
    id,
    request_id: requestId,
    workflow_revision: 1,
    stage_order: 1,
    queue_id: "department_budget",
    status: "completed",
    started_at: T(started),
    completed_at: completed === null ? null : T(completed),
    ...rest,
  };
}

/** The section 5 dataset (requests A-F; P is a browser prototype). */
function section5() {
  const requests = [
    request("A", "approved", "11-02T12:58:30"),
    request("B", "rejected", "11-10T08:59:00"),
    request("C", "approved", "11-12T10:00:00"),
    request("D", "approved", "10-30T11:59:00"),
    request("E", "submitted", "11-25T00:00:00"),
    request("F", "submitted", "11-14T16:00:00"),
  ];
  const stages = [
    stage("A1", "A", { started: "11-02T13:00:00", completed: "11-04T13:00:00" }),
    stage("A2", "A", {
      stage_order: 2,
      queue_id: "dean_office",
      started: "11-04T13:00:00",
      completed: "11-07T01:00:00",
    }),
    stage("B1", "B", { started: "11-10T09:00:00", completed: "11-10T21:00:00" }),
    stage("C1", "C", {
      queue_id: "research_admin",
      status: "active",
      started: "11-12T10:00:20",
      completed: null,
    }),
    stage("D1", "D", { started: "10-30T12:00:00", completed: "11-01T12:00:00" }),
    stage("E1", "E", { status: "active", started: "11-25T00:00:10", completed: null }),
  ];
  const prototypes = [request("P", "submitted", "11-05T10:00:00")];
  return { requests, stages, prototypes };
}

function indexOf(
  requests: readonly EfficiencyRequestRow[],
  stages: readonly EfficiencyStageRow[],
): DatasetIndex<EfficiencyRequestRow, EfficiencyStageRow> {
  const result = indexDataset({ requests, stages });
  if (result.status !== "indexed") throw new Error("fixture has duplicate ids");
  return result.index;
}

function classify(
  metricId: EfficiencyMetricId,
  requests: readonly EfficiencyRequestRow[],
  stages: readonly EfficiencyStageRow[],
  prototypeRequests: readonly EfficiencyRequestRow[] = [],
): MetricClassification<EfficiencyRequestRow, EfficiencyStageRow> {
  return classifyMetricPopulation(metricId, {
    index: indexOf(requests, stages),
    prototypeRequests,
  });
}

const ids = (records: readonly { readonly id: string }[]) => records.map((record) => record.id);
const excludedIds = (result: SubjectPopulationResult<EfficiencyRequestRow, EfficiencyStageRow>) =>
  result.excluded.map(({ record, code }) => [record.id, code]);
const conditionCodes = (population: MetricPopulation) =>
  population.conditions.map((condition) => condition.exclusion);

/** Every population the catalog defines, with its flags. */
const catalogPopulations = () =>
  EFFICIENCY_METRIC_IDS.flatMap((id) => {
    const metric = EFFICIENCY_METRICS[id];
    return [
      { label: id, population: metric.population, flags: metric.flags },
      ...metric.separateReports.map((report) => ({
        label: `${id} ${report.code}`,
        population: report.population,
        flags: [] as readonly DataQualityCode[],
      })),
    ];
  });

const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Catalog coverage
// ---------------------------------------------------------------------------

describe("catalog coverage", () => {
  it("has a predicate for every catalog exclusion code, for the population's subject", () => {
    for (const { label, population } of catalogPopulations()) {
      const table =
        population.subject === "request"
          ? REQUEST_CONDITION_PREDICATES
          : STAGE_CONDITION_PREDICATES;
      for (const code of conditionCodes(population)) {
        expect(typeof table[code], `${label}: ${code}`).toBe("function");
      }
    }
  });

  it("has a predicate only for catalog exclusion codes, with no leftovers", () => {
    const used = new Set(
      catalogPopulations().flatMap(({ population }) => conditionCodes(population)),
    );
    const defined = [
      ...Object.keys(REQUEST_CONDITION_PREDICATES),
      ...Object.keys(STAGE_CONDITION_PREDICATES),
    ];
    expect(new Set(defined)).toEqual(used);
    for (const code of defined) {
      expect(DATA_QUALITY_CHECKS[code as DataQualityCode].treatment).toBe("excluded");
    }
  });

  it("has a flag rule of the catalog-determined level for every catalog flag", () => {
    for (const id of EFFICIENCY_METRIC_IDS) {
      const metric = EFFICIENCY_METRICS[id];
      const rules = metric.population.subject === "stage" ? STAGE_FLAG_RULES : REQUEST_FLAG_RULES;
      for (const flag of metric.flags) {
        const rule = rules[flag];
        expect(rule, `${id}: ${flag}`).toBeDefined();
        const level =
          DATA_QUALITY_CHECKS[flag].subject === metric.population.subject ? "record" : "group";
        expect(rule?.level).toBe(level);
      }
    }
    expect(STAGE_FLAG_RULES.duplicate_active_stages?.level).toBe("group");
    expect(STAGE_FLAG_RULES.unknown_queue?.level).toBe("record");
  });

  it("has a scope of the catalog subject for every metric family and separate report", () => {
    for (const id of EFFICIENCY_METRIC_IDS) {
      const metric = EFFICIENCY_METRICS[id];
      expect(POPULATION_SCOPES[metric.family].subject).toBe(metric.population.subject);
      for (const report of metric.separateReports) {
        expect(SEPARATE_REPORT_SCOPES[report.code]?.subject).toBe(report.population.subject);
      }
    }
  });

  it("reports every metric's exclusion counts in the catalog's condition order, starting at 0", () => {
    for (const id of EFFICIENCY_METRIC_IDS) {
      const result = classify(id, [], []);
      const metric = EFFICIENCY_METRICS[id];
      expect(Object.keys(result.population.exclusionCounts)).toEqual(
        conditionCodes(metric.population),
      );
      expect(Object.values(result.population.exclusionCounts).every((count) => count === 0)).toBe(
        true,
      );
      expect(Object.keys(result.population.flagCounts)).toEqual([...metric.flags]);
      expect(Object.keys(result.separateReports)).toEqual(
        metric.separateReports.map((r) => r.code),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The generic engine
// ---------------------------------------------------------------------------

describe("classifyRecords", () => {
  type Item = {
    readonly id: string;
    readonly fails: readonly DataQualityCode[];
    readonly flag?: boolean;
  };
  const population: MetricPopulation = {
    subject: "stage",
    scope: "Test items.",
    conditions: [
      { requirement: "a", exclusion: "orphaned_active_stage" },
      { requirement: "b", exclusion: "in_progress_stage" },
      { requirement: "c", exclusion: "skipped_or_cancelled_stage" },
    ],
  };
  const predicates = {
    orphaned_active_stage: (item: Item) => item.fails.includes("orphaned_active_stage"),
    in_progress_stage: (item: Item) => item.fails.includes("in_progress_stage"),
    skipped_or_cancelled_stage: (item: Item) => item.fails.includes("skipped_or_cancelled_stage"),
  };
  const run = (
    candidates: readonly Item[],
    extra: Partial<Parameters<typeof classifyRecords<Item, Item>>[0]> = {},
  ) =>
    classifyRecords<Item, Item>({
      population,
      candidates,
      recordOf: (item) => item,
      inScope: (item) => !item.id.startsWith("out"),
      predicates,
      ...extra,
    });

  it("includes a record that fails no condition", () => {
    const ok: Item = { id: "ok", fails: [] };
    const result = run([ok]);
    expect(result.included).toEqual([ok]);
    expect(result.included[0]).toBe(ok);
    expect(result.excluded).toEqual([]);
    expect(result.inScope).toBe(1);
  });

  it("gives a record failing several conditions only the earliest catalog code", () => {
    const allThree: Item = {
      id: "x",
      fails: ["skipped_or_cancelled_stage", "in_progress_stage", "orphaned_active_stage"],
    };
    const lastTwo: Item = { id: "y", fails: ["skipped_or_cancelled_stage", "in_progress_stage"] };
    const result = run([allThree, lastTwo]);
    expect(result.excluded).toEqual([
      { record: allThree, code: "orphaned_active_stage" },
      { record: lastTwo, code: "in_progress_stage" },
    ]);
    expect(result.exclusionCounts).toEqual({
      orphaned_active_stage: 1,
      in_progress_stage: 1,
      skipped_or_cancelled_stage: 0,
    });
    const total = Object.values(result.exclusionCounts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBe(result.excluded.length);
  });

  it("follows the order the population lists, not the predicate table's order", () => {
    const reversed: MetricPopulation = {
      ...population,
      conditions: [...population.conditions].reverse(),
    };
    const item: Item = { id: "x", fails: ["orphaned_active_stage", "skipped_or_cancelled_stage"] };
    const result = classifyRecords<Item, Item>({
      population: reversed,
      candidates: [item],
      recordOf: (i) => i,
      inScope: () => true,
      predicates,
    });
    expect(result.excluded[0].code).toBe("skipped_or_cancelled_stage");
    expect(Object.keys(result.exclusionCounts)).toEqual([
      "skipped_or_cancelled_stage",
      "in_progress_stage",
      "orphaned_active_stage",
    ]);
  });

  it("stops checking at the first failed condition", () => {
    const calls: string[] = [];
    const tracking = Object.fromEntries(
      Object.entries(predicates).map(([code, test]) => [
        code,
        (item: Item) => {
          calls.push(code);
          return test(item);
        },
      ]),
    );
    run([{ id: "x", fails: ["orphaned_active_stage", "in_progress_stage"] }], {
      predicates: tracking,
    });
    expect(calls).toEqual(["orphaned_active_stage"]);
  });

  it("ignores records outside the scope entirely", () => {
    const out: Item = { id: "out-1", fails: ["orphaned_active_stage"], flag: true };
    const result = run([out], {
      flags: ["unknown_queue"],
      flagRules: { unknown_queue: { level: "record", test: (item: Item) => Boolean(item.flag) } },
    });
    expect(result).toEqual({
      inScope: 0,
      included: [],
      excluded: [],
      exclusionCounts: {
        orphaned_active_stage: 0,
        in_progress_stage: 0,
        skipped_or_cancelled_stage: 0,
      },
      flagged: [],
      flagCounts: { unknown_queue: 0 },
    });
  });

  it("handles empty input explicitly", () => {
    const result = run([]);
    expect(result.inScope).toBe(0);
    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.exclusionCounts).toEqual({
      orphaned_active_stage: 0,
      in_progress_stage: 0,
      skipped_or_cancelled_stage: 0,
    });
  });

  it("flags only records that pass every condition, and never removes them", () => {
    const passes: Item = { id: "p", fails: [], flag: true };
    const excluded: Item = { id: "e", fails: ["in_progress_stage"], flag: true };
    const result = run([passes, excluded], {
      flags: ["unknown_queue"],
      flagRules: { unknown_queue: { level: "record", test: (item: Item) => Boolean(item.flag) } },
    });
    expect(result.included).toEqual([passes]);
    expect(result.flagged).toEqual([{ record: passes, flags: ["unknown_queue"] }]);
    expect(result.flagCounts).toEqual({ unknown_queue: 1 });
  });

  it("fails loudly when a condition has no predicate, before looking at any record", () => {
    const { skipped_or_cancelled_stage: _dropped, ...partial } = predicates;
    expect(() => run([], { predicates: partial })).toThrow(
      'No predicate for catalog condition "skipped_or_cancelled_stage" (stage population).',
    );
  });

  it("fails loudly when a flag has no rule or a rule of the wrong level", () => {
    expect(() => run([], { flags: ["unknown_queue"] })).toThrow(
      'No rule for catalog flag "unknown_queue".',
    );
    expect(() =>
      run([], {
        flags: ["duplicate_active_stages"],
        flagRules: { duplicate_active_stages: { level: "record", test: () => true } },
      }),
    ).toThrow('Flag "duplicate_active_stages" must be a group-level rule for a stage population.');
  });
});

// ---------------------------------------------------------------------------
// Section 5 worked examples
// ---------------------------------------------------------------------------

describe("section 5 populations", () => {
  const { requests, stages, prototypes } = section5();

  it("5.1 Request Volume: every real request in scope; the prototype is excluded", () => {
    const { population } = classify("request_volume", requests, stages, prototypes);
    expect(population.subject).toBe("request");
    // Classification is not per period: D (October) is included here and is
    // left out of November later, by its anchor.
    expect(ids(population.included as EfficiencyRequestRow[])).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
    expect(excludedIds(population)).toEqual([["P", "prototype_request"]]);
    expect(population.exclusionCounts).toEqual({ prototype_request: 1, invalid_created_at: 0 });
  });

  it("5.2 Active Queue Workload: C1 orphaned, E1 included; F reported without stages, P excluded", () => {
    const result = classify("active_queue_workload", requests, stages, prototypes);
    expect(result.population.inScope).toBe(2);
    expect(ids(result.population.included as EfficiencyStageRow[])).toEqual(["E1"]);
    expect(excludedIds(result.population)).toEqual([["C1", "orphaned_active_stage"]]);
    expect(result.population.flagCounts).toEqual({ duplicate_active_stages: 0, unknown_queue: 0 });
    const report = result.separateReports.pending_without_stage;
    expect(ids((report?.included ?? []) as EfficiencyRequestRow[])).toEqual(["F"]);
    expect(report && excludedIds(report)).toEqual([["P", "prototype_request"]]);
  });

  it("5.2 second snapshot: duplicate active stages counted once per request; unknown queue flagged", () => {
    const pending = ["R1", "R2", "R3", "R5", "R6"].map((id) =>
      request(id, "under_review", "11-20T00:00:00"),
    );
    const active = (id: string, requestId: string, queue_id: string, order = 1) =>
      stage(id, requestId, { queue_id, status: "active", stage_order: order, completed: null });
    const snapshotStages = [
      active("R1-1", "R1", "department_budget"),
      active("R2-1", "R2", "department_budget"),
      active("R3-1", "R3", "dean_office"),
      active("R5-1", "R5", "research_admin"),
      active("R5-2", "R5", "research_admin", 2),
      active("R6-1", "R6", "procurement"),
    ];
    const { population } = classify("active_queue_workload", pending, snapshotStages);
    expect(population.included).toHaveLength(6);
    expect(population.flagCounts).toEqual({ duplicate_active_stages: 1, unknown_queue: 1 });
    expect(population.flagged.map(({ record, flags }) => [record.id, flags])).toEqual([
      ["R5-1", ["duplicate_active_stages"]],
      ["R5-2", ["duplicate_active_stages"]],
      ["R6-1", ["unknown_queue"]],
    ]);
  });

  it("5.3 Stage Processing Time: C1 orphaned (not in progress), E1 in progress", () => {
    const { population } = classify("stage_processing_time_average", requests, stages);
    expect(ids(population.included as EfficiencyStageRow[])).toEqual(["A1", "A2", "B1", "D1"]);
    expect(excludedIds(population)).toEqual([
      ["C1", "orphaned_active_stage"],
      ["E1", "in_progress_stage"],
    ]);
    expect(classify("stage_processing_time_median", requests, stages).population).toEqual(
      population,
    );
  });

  it("5.3 unknown queue: U1 stays included and is flagged", () => {
    const u1 = stage("U1", "U", {
      queue_id: "procurement",
      started: "11-16T00:00:00",
      completed: "11-17T00:00:00",
    });
    const { population } = classify(
      "stage_processing_time_average",
      [...requests, request("U", "approved", "11-15T00:00:00")],
      [...stages, u1],
    );
    expect(population.included).toContain(u1);
    expect(population.flagged).toEqual([{ record: u1, flags: ["unknown_queue"] }]);
    expect(population.flagCounts).toEqual({ unknown_queue: 1 });
  });

  it("5.4-5.5 tracked terminal population: A, B, D included; C has an active stage; pending out of scope", () => {
    for (const id of [
      "request_turnaround_time_average",
      "request_turnaround_time_median",
      "approval_rate",
    ] as const) {
      const { population } = classify(id, requests, stages, prototypes);
      expect(population.inScope).toBe(4);
      expect(ids(population.included as EfficiencyRequestRow[])).toEqual(["A", "B", "D"]);
      expect(excludedIds(population)).toEqual([["C", "terminal_request_with_active_stage"]]);
    }
  });

  it("5.6 Queue Throughput: non-active stages only; active stages are out of scope, not excluded", () => {
    const { population } = classify("queue_throughput", requests, stages);
    expect(population.inScope).toBe(4);
    expect(ids(population.included as EfficiencyStageRow[])).toEqual(["A1", "A2", "B1", "D1"]);
    expect(population.excluded).toEqual([]);
  });

  it("5.6 Queue Throughput classifies a stage-only read", () => {
    const { population } = classify("queue_throughput", [], stages);
    expect(ids(population.included as EfficiencyStageRow[])).toEqual(["A1", "A2", "B1", "D1"]);
  });

  it("5.8 amended request H: H3 decides; H2 cancelled is excluded only from stage metrics", () => {
    const h = [request("H", "approved", "11-03T09:00:00")];
    const hStages = [
      stage("H1", "H", { started: "11-03T09:00:00", completed: "11-04T09:00:00" }),
      stage("H2", "H", {
        stage_order: 2,
        queue_id: "dean_office",
        status: "cancelled",
        started: "11-04T09:00:00",
        completed: "11-05T09:00:00",
      }),
      stage("H3", "H", {
        workflow_revision: 2,
        started: "11-05T09:00:00",
        completed: "11-06T21:00:00",
      }),
    ];
    expect(
      ids(classify("approval_rate", h, hStages).population.included as EfficiencyRequestRow[]),
    ).toEqual(["H"]);
    expect(decisionInstant(hStages)?.toISOString()).toBe("2026-11-06T21:00:00.000Z");
    for (const id of ["stage_processing_time_average", "queue_throughput"] as const) {
      const { population } = classify(id, h, hStages);
      expect(ids(population.included as EfficiencyStageRow[])).toEqual(["H1", "H3"]);
      expect(excludedIds(population)).toEqual([["H2", "skipped_or_cancelled_stage"]]);
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence and edge cases on real catalog populations
// ---------------------------------------------------------------------------

describe("precedence and edge cases", () => {
  it("a prototype with an unparseable created_at counts once, as prototype_request", () => {
    const bad = { ...request("P", "submitted", "11-05T10:00:00"), created_at: "not a time" };
    const { population } = classify("request_volume", [], [], [bad]);
    expect(excludedIds(population)).toEqual([["P", "prototype_request"]]);
  });

  it("a real request with an invalid created_at is invalid_created_at in Volume", () => {
    const bad = { ...request("X", "submitted", "11-05T10:00:00"), created_at: "2026-11-05" };
    expect(excludedIds(classify("request_volume", [bad], []).population)).toEqual([
      ["X", "invalid_created_at"],
    ]);
  });

  it("follows section 5.4 precedence in the tracked terminal population", () => {
    const completedNoStages = request("K", "completed", "11-01T00:00:00");
    const invalidCreatedNoStages = {
      ...request("L", "approved", "11-01T00:00:00"),
      created_at: null as unknown as string,
    };
    const untracked = request("M", "rejected", "11-01T00:00:00");
    const { population } = classify(
      "approval_rate",
      [completedNoStages, invalidCreatedNoStages, untracked],
      [],
    );
    expect(excludedIds(population)).toEqual([
      ["K", "completed_status"],
      ["L", "invalid_created_at"],
      ["M", "untracked_terminal_request"],
    ]);
  });

  it("excludes a decision before creation, and accepts a decision at the creation instant", () => {
    const early = request("N", "approved", "11-20T00:00:00");
    const same = request("O", "approved", "11-19T00:00:00");
    const { population } = classify(
      "request_turnaround_time_average",
      [early, same],
      [
        stage("N1", "N", { started: "11-18T00:00:00", completed: "11-19T00:00:00" }),
        stage("O1", "O", { started: "11-18T00:00:00", completed: "11-19T00:00:00" }),
      ],
    );
    expect(excludedIds(population)).toEqual([["N", "decision_before_creation"]]);
    expect(ids(population.included as EfficiencyRequestRow[])).toEqual(["O"]);
  });

  it("marks terminal_stage_invalid for a cancelled decisive stage, a tie, or an invalid key, never falling back", () => {
    const requests = ["Q1", "Q2", "Q3", "Q4"].map((id) =>
      request(id, "approved", "11-01T00:00:00"),
    );
    const stages = [
      // Q1: revision 2 ended cancelled; revision 1's completed stage must not decide.
      stage("q1a", "Q1", {}),
      stage("q1b", "Q1", { workflow_revision: 2, status: "cancelled" }),
      // Q2: two completed stages tied at the highest pair.
      stage("q2a", "Q2", { stage_order: 2 }),
      stage("q2b", "Q2", { stage_order: 2, queue_id: "dean_office" }),
      // Q3: a null stage_order below a clearly higher stage.
      stage("q3a", "Q3", { stage_order: null as unknown as number }),
      stage("q3b", "Q3", { workflow_revision: 3 }),
      // Q4: decisive stage completed but its completed_at is not a valid instant.
      { ...stage("q4a", "Q4", {}), completed_at: "2026-11-02" },
    ];
    const { population } = classify("approval_rate", requests, stages);
    expect(excludedIds(population)).toEqual([
      ["Q1", "terminal_stage_invalid"],
      ["Q2", "terminal_stage_invalid"],
      ["Q3", "terminal_stage_invalid"],
      ["Q4", "terminal_stage_invalid"],
    ]);
  });

  it("checks an active stage in any revision before the decisive stage", () => {
    const r = request("R", "approved", "11-01T00:00:00");
    const stages = [
      stage("r1", "R", { status: "active", completed: null }),
      stage("r2", "R", { workflow_revision: 2 }),
    ];
    expect(excludedIds(classify("approval_rate", [r], stages).population)).toEqual([
      ["R", "terminal_request_with_active_stage"],
    ]);
  });

  it("puts unrecognized_stage_status after skipped_or_cancelled_stage and before completion checks", () => {
    const r = request("S", "approved", "11-01T00:00:00");
    const stages = [
      stage("weird", "S", { status: "rejected", completed: null }),
      stage("nullStatus", "S", { stage_order: 2, status: null as unknown as string }),
      stage("skipped", "S", { stage_order: 3, status: "skipped", completed: null }),
      stage("noCompletedAt", "S", { stage_order: 4, completed: null }),
      stage("reversed", "S", {
        stage_order: 5,
        started: "11-03T00:00:00",
        completed: "11-02T00:00:00",
      }),
    ];
    for (const id of ["stage_processing_time_average", "queue_throughput"] as const) {
      expect(excludedIds(classify(id, [r], stages).population)).toEqual([
        ["weird", "unrecognized_stage_status"],
        ["nullStatus", "unrecognized_stage_status"],
        ["skipped", "skipped_or_cancelled_stage"],
        ["noCompletedAt", "stage_missing_completed_at"],
        ["reversed", "invalid_stage_timestamps"],
      ]);
    }
  });

  it("counts an orphaned active stage of a completed request, never as in progress", () => {
    const g = request("G", "completed", "11-01T00:00:00");
    const g1 = stage("G1", "G", { queue_id: "dean_office", status: "active", completed: null });
    expect(excludedIds(classify("stage_processing_time_average", [g], [g1]).population)).toEqual([
      ["G1", "orphaned_active_stage"],
    ]);
    expect(excludedIds(classify("active_queue_workload", [g], [g1]).population)).toEqual([
      ["G1", "orphaned_active_stage"],
    ]);
  });

  it("keeps out-of-scope records out of every count", () => {
    const pending = request("E", "submitted", "11-25T00:00:00");
    const withStage = request("W", "submitted", "11-25T00:00:00");
    const done = stage("W0", "W", {});
    const terminal = classify("approval_rate", [pending], []);
    expect(terminal.population.inScope).toBe(0);
    expect(terminal.population.excluded).toEqual([]);
    // A pending request with a stage of any status is never pending_without_stage.
    const workload = classify("active_queue_workload", [withStage], [done]);
    expect(workload.population.inScope).toBe(0);
    expect(workload.separateReports.pending_without_stage?.inScope).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flags and exclusions together
// ---------------------------------------------------------------------------

describe("flags", () => {
  it("gives one record several flags, in catalog order", () => {
    const r = request("R7", "submitted", "11-20T00:00:00");
    const known = stage("k", "R7", { status: "active", completed: null });
    const unknown = stage("u", "R7", {
      stage_order: 2,
      queue_id: "procurement",
      status: "active",
      completed: null,
    });
    const { population } = classify("active_queue_workload", [r], [known, unknown]);
    expect(population.included).toEqual([known, unknown]);
    expect(population.flagged).toEqual([
      { record: known, flags: ["duplicate_active_stages"] },
      { record: unknown, flags: ["duplicate_active_stages", "unknown_queue"] },
    ]);
    expect(population.flagCounts).toEqual({ duplicate_active_stages: 1, unknown_queue: 1 });
  });

  it("never flags an excluded record, and builds request groups only from included stages", () => {
    const approved = request("Z", "approved", "11-01T00:00:00");
    const orphans = [
      stage("z1", "Z", { queue_id: "procurement", status: "active", completed: null }),
      stage("z2", "Z", { stage_order: 2, status: "active", completed: null }),
    ];
    const workload = classify("active_queue_workload", [approved], orphans).population;
    expect(workload.excluded.map(({ code }) => code)).toEqual([
      "orphaned_active_stage",
      "orphaned_active_stage",
    ]);
    expect(workload.flagged).toEqual([]);
    expect(workload.flagCounts).toEqual({ duplicate_active_stages: 0, unknown_queue: 0 });

    const cancelledUnknown = stage("c", "Z", { queue_id: "procurement", status: "cancelled" });
    const stageTime = classify(
      "stage_processing_time_average",
      [approved],
      [cancelledUnknown],
    ).population;
    expect(excludedIds(stageTime)).toEqual([["c", "skipped_or_cancelled_stage"]]);
    expect(stageTime.flagCounts).toEqual({ unknown_queue: 0 });
  });

  it("does not flag a single active stage as a duplicate", () => {
    const r = request("Y", "under_review", "11-01T00:00:00");
    const { population } = classify(
      "active_queue_workload",
      [r],
      [
        stage("y0", "Y", {}),
        stage("y1", "Y", { stage_order: 2, status: "active", completed: null }),
      ],
    );
    expect(population.flagCounts.duplicate_active_stages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Predicates on their own
// ---------------------------------------------------------------------------

describe("predicates", () => {
  const req = (overrides: Partial<RequestCandidate> = {}): RequestCandidate => ({
    record: request("r", "approved", "11-01T00:00:00"),
    stages: [stage("s", "r", {})],
    prototype: false,
    ...overrides,
  });
  const stg = (
    fields: Partial<EfficiencyStageRow>,
    requestStatus?: EfficiencyRequestRow["status"],
  ): StageCandidate => ({
    record: stage("s", "r", fields),
    request: requestStatus ? request("r", requestStatus, "11-01T00:00:00") : undefined,
  });

  it("evaluates each request condition independently", () => {
    const p = REQUEST_CONDITION_PREDICATES;
    expect(p.prototype_request?.(req({ prototype: true }))).toBe(true);
    expect(p.completed_status?.(req({ record: request("r", "completed", "11-01T00:00:00") }))).toBe(
      true,
    );
    expect(p.completed_status?.(req())).toBe(false);
    expect(p.untracked_terminal_request?.(req({ stages: [] }))).toBe(true);
    expect(
      p.terminal_request_with_active_stage?.(
        req({ stages: [stage("a", "r", { status: "active" })] }),
      ),
    ).toBe(true);
    expect(p.terminal_stage_invalid?.(req())).toBe(false);
    expect(p.terminal_stage_invalid?.(req({ stages: [] }))).toBe(true);
    // decision_before_creation is false when there is no decision instant to compare.
    expect(p.decision_before_creation?.(req({ stages: [] }))).toBe(false);
  });

  it("evaluates each stage condition independently", () => {
    const p = STAGE_CONDITION_PREDICATES;
    expect(p.orphaned_active_stage?.(stg({ status: "active" }, "rejected"))).toBe(true);
    expect(p.orphaned_active_stage?.(stg({ status: "active" }, "submitted"))).toBe(false);
    expect(p.orphaned_active_stage?.(stg({ status: "completed" }, "approved"))).toBe(false);
    expect(p.in_progress_stage?.(stg({ status: "active" }))).toBe(true);
    expect(p.skipped_or_cancelled_stage?.(stg({ status: "skipped" }))).toBe(true);
    expect(p.unrecognized_stage_status?.(stg({ status: "rejected" }))).toBe(true);
    expect(p.unrecognized_stage_status?.(stg({ status: "cancelled" }))).toBe(false);
    expect(p.stage_missing_completed_at?.(stg({ completed_at: null }))).toBe(true);
    expect(p.stage_missing_completed_at?.(stg({ status: "active", completed_at: null }))).toBe(
      false,
    );
    expect(p.invalid_stage_timestamps?.(stg({ started_at: "bad" }))).toBe(true);
    expect(p.invalid_stage_timestamps?.(stg({}))).toBe(false);
  });

  it("derives the decision instant only from a completed decisive stage", () => {
    expect(decisionInstant([])).toBeNull();
    expect(decisionInstant([stage("a", "r", { status: "active", completed: null })])).toBeNull();
    expect(decisionInstant([stage("a", "r", { completed: "11-09T10:00:00" })])?.toISOString()).toBe(
      "2026-11-09T10:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Guards, identity and immutability
// ---------------------------------------------------------------------------

describe("classifyMetricPopulation guards and immutability", () => {
  it("throws when a metric needing requests receives a stage without its request", () => {
    const orphan = stage("x", "missing", {});
    expect(() => classify("stage_processing_time_average", [], [orphan])).toThrow(
      /stage_request_not_loaded/,
    );
    expect(() => classify("queue_throughput", [], [orphan])).not.toThrow();
  });

  it("returns the caller's records and leaves inputs unchanged", () => {
    const { requests, stages, prototypes } = section5();
    const frozen = {
      requests: Object.freeze(requests.map((r) => Object.freeze(r))),
      stages: Object.freeze(stages.map((s) => Object.freeze(s))),
      prototypes: Object.freeze(prototypes.map((p) => Object.freeze(p))),
    };
    const before = snapshot(frozen);
    for (const id of EFFICIENCY_METRIC_IDS) {
      const result = classify(id, frozen.requests, frozen.stages, frozen.prototypes);
      for (const record of result.population.included) {
        expect([...frozen.requests, ...frozen.stages, ...frozen.prototypes]).toContain(record);
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.population.included)).toBe(true);
      expect(Object.isFrozen(result.population.exclusionCounts)).toBe(true);
    }
    expect(snapshot(frozen)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

describe("module boundaries", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const source = read("./efficiency-classification.ts");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);

  it("imports only the F19.3 types, the catalog, the dataset helpers, the stats helpers and F18 instants", () => {
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
      "@/lib/efficiency-population",
      "@/lib/efficiency-stats",
      "@/lib/time-zones",
    ]);
    // The data layer is imported for types only, so its runtime code is not pulled in.
    expect(imports[0]).toMatch(/^import type /);
    expect(source).not.toMatch(/supabase|efficiency-data-loader|react/i);
  });

  it("is not imported by the catalog, the data layer, the dataset or stats helpers, routing or F18 modules", () => {
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-data-loader.ts",
      "./efficiency-population.ts",
      "./efficiency-stats.ts",
      "./routing/rules.ts",
      "./time-zones.ts",
      "./reporting-periods.ts",
      "./date-range-filter.ts",
    ]) {
      expect(read(file)).not.toMatch(/from\s+"[^"]*efficiency-classification"/);
    }
  });
});
