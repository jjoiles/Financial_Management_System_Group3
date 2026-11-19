import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkDatasetIntegrity,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type TableReadResult,
} from "./efficiency-data";
import {
  EFFICIENCY_METRICS,
  EFFICIENCY_METRIC_IDS,
  UNKNOWN_QUEUE_GROUP,
  type EfficiencyMetricId,
} from "./efficiency-metrics";
import { gateAllMetrics, gateMetricLoad, type MetricLoadGate } from "./efficiency-classification";
import {
  RECOGNIZED_QUEUE_IDS,
  groupStagesByQueue,
  indexDataset,
  isRecognizedQueueId,
  selectDecisiveStage,
  toQueueGroup,
  type DatasetIndex,
  type DatasetIndexResult,
  type DecisiveStageResult,
} from "./efficiency-population";
import { QUEUES } from "./routing/rules";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row shapes
// ---------------------------------------------------------------------------

function request(id: string, overrides: Partial<EfficiencyRequestRow> = {}): EfficiencyRequestRow {
  return { id, status: "approved", created_at: "2026-11-01T00:00:00+00:00", ...overrides };
}

let stageCounter = 0;
function stage(
  requestId: string,
  revision: number,
  order: number,
  overrides: Partial<EfficiencyStageRow> = {},
): EfficiencyStageRow {
  stageCounter += 1;
  return {
    id: `stage-${String(stageCounter).padStart(4, "0")}`,
    request_id: requestId,
    workflow_revision: revision,
    stage_order: order,
    queue_id: "department_budget",
    status: "completed",
    started_at: "2026-11-02T00:00:00+00:00",
    completed_at: "2026-11-03T00:00:00+00:00",
    ...overrides,
  };
}

/** A stage with a key value the TypeScript row type does not allow, as bad data could. */
function stageWithKeys(requestId: string, revision: unknown, order: unknown): EfficiencyStageRow {
  return {
    ...stage(requestId, 1, 1),
    workflow_revision: revision as number,
    stage_order: order as number,
  };
}

function indexed<R extends EfficiencyRequestRow, S extends EfficiencyStageRow>(
  result: DatasetIndexResult<R, S>,
): DatasetIndex<R, S> {
  if (result.status !== "indexed") throw new Error(`expected an index, got ${result.status}`);
  return result.index;
}

function decisive<S extends EfficiencyStageRow>(result: DecisiveStageResult<S>): S {
  if (result.status !== "decisive")
    throw new Error(`expected a decisive stage, got ${result.status}`);
  return result.stage;
}

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Dataset indexing
// ---------------------------------------------------------------------------

describe("indexDataset", () => {
  it("indexes an empty dataset", () => {
    const index = indexed(indexDataset({ requests: [], stages: [] }));
    expect(index.requestsById.size).toBe(0);
    expect(index.stagesByRequestId.size).toBe(0);
    expect(index.unmatchedStages).toEqual([]);
  });

  it("indexes requests by id and stages by request, keeping the original records in input order", () => {
    const a = request("req-a");
    const b = request("req-b");
    const a1 = stage("req-a", 1, 1);
    const b1 = stage("req-b", 1, 1);
    const a2 = stage("req-a", 1, 2);
    const index = indexed(indexDataset({ requests: [a, b], stages: [a1, b1, a2] }));

    expect([...index.requestsById.keys()]).toEqual(["req-a", "req-b"]);
    expect(index.stages).toEqual([a1, b1, a2]);
    expect(index.stages[0]).toBe(a1);
    expect(index.requestsById.get("req-a")).toBe(a);
    expect(index.stagesByRequestId.get("req-a")).toEqual([a1, a2]);
    expect(index.stagesByRequestId.get("req-a")?.[0]).toBe(a1);
    expect(index.stagesByRequestId.get("req-b")).toEqual([b1]);
    expect(index.unmatchedStages).toEqual([]);
  });

  it("gives a request with no stages an empty stage list", () => {
    const index = indexed(indexDataset({ requests: [request("req-f")], stages: [] }));
    expect(index.stagesByRequestId.get("req-f")).toEqual([]);
    expect(index.stagesByRequestId.has("req-f")).toBe(true);
  });

  it("keeps stages whose request is not in the dataset, grouped and listed as unmatched", () => {
    const known = stage("req-a", 1, 1);
    const orphan1 = stage("req-missing", 1, 1);
    const orphan2 = stage("req-missing", 1, 2);
    const index = indexed(
      indexDataset({ requests: [request("req-a")], stages: [orphan1, known, orphan2] }),
    );
    expect(index.unmatchedStages).toEqual([orphan1, orphan2]);
    expect(index.stagesByRequestId.get("req-missing")).toEqual([orphan1, orphan2]);
    expect(index.requestsById.has("req-missing")).toBe(false);
    expect(index.stagesByRequestId.get("req-a")).toEqual([known]);
  });

  it("supports a stage-only read: every stage is unmatched and none is lost", () => {
    const stages = [stage("r1", 1, 1), stage("r2", 1, 1), stage("r1", 1, 2)];
    const index = indexed(indexDataset({ requests: [], stages }));
    expect(index.unmatchedStages).toEqual(stages);
    const grouped = [...index.stagesByRequestId.values()].flat();
    expect(grouped).toHaveLength(stages.length);
  });

  it("refuses duplicate request ids instead of keeping one or both", () => {
    const result = indexDataset({
      requests: [request("dup"), request("ok"), request("dup", { status: "rejected" })],
      stages: [stage("dup", 1, 1)],
    });
    expect(result).toEqual({
      status: "duplicate-ids",
      duplicateRequestIds: ["dup"],
      duplicateStageIds: [],
    });
    expect("index" in result).toBe(false);
  });

  it("refuses duplicate stage ids and reports both kinds together, each id once", () => {
    const s = stage("req-a", 1, 1);
    const result = indexDataset({
      requests: [request("req-a"), request("req-b"), request("req-a"), request("req-a")],
      stages: [s, { ...s, stage_order: 2 }, stage("req-a", 1, 3), { ...s }],
    });
    expect(result).toEqual({
      status: "duplicate-ids",
      duplicateRequestIds: ["req-a"],
      duplicateStageIds: [s.id],
    });
  });

  it("does not modify the inputs and returns frozen containers", () => {
    const requests = Object.freeze([request("req-a"), request("req-b")]);
    const stages = Object.freeze([stage("req-a", 2, 1), stage("req-x", 1, 1)]);
    const before = snapshot({ requests, stages });
    const index = indexed(indexDataset({ requests, stages }));
    expect(snapshot({ requests, stages })).toEqual(before);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.unmatchedStages)).toBe(true);
    for (const group of index.stagesByRequestId.values()) expect(Object.isFrozen(group)).toBe(true);
    const failed = indexDataset({ requests: [request("d"), request("d")], stages: [] });
    expect(Object.isFrozen(failed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decisive stage
// ---------------------------------------------------------------------------

describe("selectDecisiveStage", () => {
  it("reports no stages", () => {
    expect(selectDecisiveStage([])).toEqual({ status: "no-stages" });
  });

  it("selects the only stage, whatever its status", () => {
    const only = stage("r", 1, 1, { status: "cancelled" });
    expect(decisive(selectDecisiveStage([only]))).toBe(only);
  });

  it("selects the highest stage_order within one revision", () => {
    const s1 = stage("r", 1, 1);
    const s2 = stage("r", 1, 2);
    const s3 = stage("r", 1, 3);
    expect(decisive(selectDecisiveStage([s2, s3, s1]))).toBe(s3);
  });

  it("orders by revision first: section 5.8 picks H3, not the cancelled H2", () => {
    const h1 = stage("H", 1, 1, { status: "completed" });
    const h2 = stage("H", 1, 2, { status: "cancelled", queue_id: "dean_office" });
    const h3 = stage("H", 2, 1, { status: "completed" });
    for (const order of [
      [h1, h2, h3],
      [h3, h2, h1],
      [h2, h3, h1],
    ]) {
      expect(decisive(selectDecisiveStage(order))).toBe(h3);
    }
  });

  it("compares revisions numerically: revision 10 is newer than revision 9", () => {
    const rev9 = stage("r", 9, 5);
    const rev10 = stage("r", 10, 1);
    const rev2 = stage("r", 2, 7);
    expect(decisive(selectDecisiveStage([rev9, rev10, rev2]))).toBe(rev10);
    // As text, "9" > "10" and stage_order "10" < "9"; numbers must win.
    const order9 = stage("r", 3, 9);
    const order10 = stage("r", 3, 10);
    expect(decisive(selectDecisiveStage([order10, order9]))).toBe(order10);
  });

  it("selects the newest revision even when it has fewer stages", () => {
    const old = [stage("r", 1, 1), stage("r", 1, 2), stage("r", 1, 3)];
    const restarted = stage("r", 2, 1, { status: "active" });
    expect(decisive(selectDecisiveStage([...old, restarted]))).toBe(restarted);
  });

  it("is invalid when two stages share the highest pair, and returns the tied stages", () => {
    const low = stage("r", 1, 1);
    const tieA = stage("r", 2, 3);
    const tieB = stage("r", 2, 3, { queue_id: "dean_office" });
    expect(selectDecisiveStage([tieA, low, tieB])).toEqual({
      status: "invalid",
      reason: "tied-highest-pair",
      stages: [tieA, tieB],
    });
    const three = [stage("r", 4, 1), stage("r", 4, 1), stage("r", 4, 1)];
    const result = selectDecisiveStage(three);
    expect(result.status === "invalid" && result.stages).toEqual(three);
  });

  it("ignores a tie below the highest pair", () => {
    const tieA = stage("r", 1, 2);
    const tieB = stage("r", 1, 2);
    const top = stage("r", 2, 1);
    expect(decisive(selectDecisiveStage([tieA, tieB, top]))).toBe(top);
    const sameRevision = [stage("r", 1, 1), stage("r", 1, 1), stage("r", 1, 2)];
    expect(decisive(selectDecisiveStage(sameRevision))).toBe(sameRevision[2]);
  });

  it.each([
    ["null revision", null, 1],
    ["null stage_order", 1, null],
    ["undefined revision", undefined, 1],
    ["fractional revision", 1.5, 1],
    ["fractional stage_order", 1, 2.5],
    ["string revision", "10", 1],
    ["string stage_order", 1, "2"],
    ["NaN", Number.NaN, 1],
    ["Infinity", 1, Number.POSITIVE_INFINITY],
    ["unsafe integer", 2 ** 53, 1],
    ["boolean", true, 1],
  ])("is invalid when any stage has a %s key", (_label, revision, order) => {
    const bad = stageWithKeys("r", revision, order);
    const good = stage("r", 1, 1);
    const higher = stage("r", 5, 1);
    // Invalid wherever it would sort, including below a clearly higher stage.
    expect(selectDecisiveStage([good, bad, higher])).toEqual({
      status: "invalid",
      reason: "invalid-ordering-key",
      stages: [bad],
    });
  });

  it("reports every stage with an invalid key, before any tie", () => {
    const bad1 = stageWithKeys("r", null, 1);
    const bad2 = stageWithKeys("r", 1, "x");
    const tie = [stage("r", 3, 1), stage("r", 3, 1)];
    const result = selectDecisiveStage([bad1, ...tie, bad2]);
    expect(result).toEqual({
      status: "invalid",
      reason: "invalid-ordering-key",
      stages: [bad1, bad2],
    });
  });

  it("accepts zero and negative integers; ranges are the database's concern", () => {
    const zero = stage("r", 0, 1);
    const negative = stage("r", -1, 9);
    expect(decisive(selectDecisiveStage([negative, zero]))).toBe(zero);
  });

  it("does not modify the input and returns frozen results", () => {
    const stages = Object.freeze([stage("r", 1, 2), stage("r", 1, 1), stage("r", 2, 1)]);
    const before = snapshot(stages);
    const result = selectDecisiveStage(stages);
    expect(snapshot(stages)).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    const tied = selectDecisiveStage([stage("r", 1, 1), stage("r", 1, 1)]);
    expect(Object.isFrozen(tied)).toBe(true);
    expect(tied.status === "invalid" && Object.isFrozen(tied.stages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Queue groups
// ---------------------------------------------------------------------------

describe("queue groups", () => {
  it("derives the recognized queues from QUEUES, in its order", () => {
    expect([...RECOGNIZED_QUEUE_IDS]).toEqual(Object.keys(QUEUES));
    expect(RECOGNIZED_QUEUE_IDS).toHaveLength(6);
    expect(Object.isFrozen(RECOGNIZED_QUEUE_IDS)).toBe(true);
    expect(RECOGNIZED_QUEUE_IDS as readonly string[]).not.toContain(UNKNOWN_QUEUE_GROUP);
    expect(read("./efficiency-population.ts")).not.toMatch(
      /"department_budget"|'department_budget'/,
    );
  });

  it("matches the database queue allowlist (f19_is_valid_queue_id)", () => {
    const migration = read("../../supabase/migrations/20261119030549_f19_2_workflow_integrity.sql");
    const allowlist = migration.split("FUNCTION public.f19_is_valid_queue_id")[1]?.split("$$;")[0];
    const allowed = [...(allowlist ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(allowed.sort()).toEqual([...RECOGNIZED_QUEUE_IDS].sort());
  });

  it("recognizes only exact, own QueueId keys", () => {
    for (const queueId of RECOGNIZED_QUEUE_IDS) {
      expect(isRecognizedQueueId(queueId)).toBe(true);
      expect(toQueueGroup(queueId)).toBe(queueId);
    }
    for (const value of [
      "procurement",
      "Department_Budget",
      " department_budget",
      "department_budget ",
      "",
      "unknown",
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      null,
      undefined,
      42,
    ]) {
      expect(isRecognizedQueueId(value)).toBe(false);
      expect(toQueueGroup(value)).toBe(UNKNOWN_QUEUE_GROUP);
    }
  });

  it("assigns stages to recognized queues, with every queue present and empty ones empty", () => {
    const budget1 = stage("a", 1, 1, { queue_id: "department_budget" });
    const dean = stage("a", 1, 2, { queue_id: "dean_office" });
    const budget2 = stage("b", 1, 1, { queue_id: "department_budget" });
    const groups = groupStagesByQueue([budget1, dean, budget2]);
    expect(Object.keys(groups.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);
    expect(groups.recognized.department_budget).toEqual([budget1, budget2]);
    expect(groups.recognized.department_budget[0]).toBe(budget1);
    expect(groups.recognized.dean_office).toEqual([dean]);
    for (const queueId of [
      "research_admin",
      "provost_finance",
      "sponsored_programs",
      "cfo_office",
    ] as const) {
      expect(groups.recognized[queueId]).toEqual([]);
    }
    expect(groups.unknown).toEqual([]);
  });

  it("puts unrecognized queue ids in the unknown group with their queue_id unchanged", () => {
    const procurement = stage("a", 1, 1, { queue_id: "procurement" });
    const cased = stage("b", 1, 1, { queue_id: "Dean_Office" });
    const nullQueue = { ...stage("c", 1, 1), queue_id: null as unknown as string };
    const known = stage("d", 1, 1, { queue_id: "cfo_office" });
    const groups = groupStagesByQueue([procurement, known, cased, nullQueue]);
    expect(groups.unknown).toEqual([procurement, cased, nullQueue]);
    expect(groups.unknown.map((s) => s.queue_id)).toEqual(["procurement", "Dean_Office", null]);
    expect(groups.recognized.cfo_office).toEqual([known]);
  });

  it("groups an empty input into empty recognized queues and no unknown stages", () => {
    const groups = groupStagesByQueue([]);
    expect(Object.keys(groups.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);
    for (const queueId of RECOGNIZED_QUEUE_IDS) expect(groups.recognized[queueId]).toEqual([]);
    expect(groups.unknown).toEqual([]);
  });

  it("keeps every stage exactly once and does not modify the input", () => {
    const stages = Object.freeze([
      stage("a", 1, 1, { queue_id: "research_admin" }),
      stage("a", 1, 2, { queue_id: "sponsored_programs" }),
      stage("b", 1, 1, { queue_id: "legacy_queue" }),
      stage("c", 1, 1, { queue_id: "research_admin" }),
    ]);
    const before = snapshot(stages);
    const groups = groupStagesByQueue(stages);
    const placed = [...Object.values(groups.recognized).flat(), ...groups.unknown];
    expect(placed).toHaveLength(stages.length);
    expect(new Set(placed)).toEqual(new Set(stages));
    expect(snapshot(stages)).toEqual(before);
    expect(Object.isFrozen(groups)).toBe(true);
    expect(Object.isFrozen(groups.recognized)).toBe(true);
    expect(Object.isFrozen(groups.unknown)).toBe(true);
    for (const queueId of RECOGNIZED_QUEUE_IDS) {
      expect(Object.isFrozen(groups.recognized[queueId])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Load-integrity gating
// ---------------------------------------------------------------------------

describe("gateMetricLoad", () => {
  const WINDOW = {
    readStartedAt: "2026-11-19T08:00:00.000Z",
    readCompletedAt: "2026-11-19T08:00:01.000Z",
  };

  // Table reads in the real F19.3 shapes; loads come from the real checkDatasetIntegrity.
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

  const requestRows = [request("req-a"), request("req-b", { status: "submitted" })];
  const stageRows = [stage("req-a", 1, 1), stage("req-b", 1, 1, { status: "active" })];

  const load = (
    requests: TableReadResult<EfficiencyRequestRow>,
    stages: TableReadResult<EfficiencyStageRow>,
  ): DatasetIntegrityResult => checkDatasetIntegrity({ requests, stages });

  const BOTH_TABLES: EfficiencyMetricId[] = [
    "active_queue_workload",
    "stage_processing_time_average",
    "stage_processing_time_median",
    "request_turnaround_time_average",
    "request_turnaround_time_median",
    "approval_rate",
  ];

  const blocked = (gate: MetricLoadGate) => {
    if (gate.status !== "blocked")
      throw new Error(`${gate.metricId}: expected blocked, got ${gate.status}`);
    return gate;
  };
  const ready = (gate: MetricLoadGate) => {
    if (gate.status !== "ready")
      throw new Error(`${gate.metricId}: expected ready, got ${gate.status}`);
    return gate;
  };

  it("makes every metric ready on a complete load, with exactly its required tables", () => {
    const result = load(complete(requestRows), complete(stageRows));
    expect(result.status).toBe("complete");
    const dataset = result.status === "complete" ? result.dataset : null;
    for (const id of EFFICIENCY_METRIC_IDS) {
      const gate = ready(gateMetricLoad(id, result));
      expect(Object.keys(gate.tables).sort()).toEqual(
        [...EFFICIENCY_METRICS[id].requiredReads].sort(),
      );
      if (gate.tables.financial_requests) {
        expect(gate.tables.financial_requests.rows).toBe(dataset?.requests);
        expect(gate.tables.financial_requests.window).toEqual(WINDOW);
      }
      if (gate.tables.approval_stage_tracking) {
        expect(gate.tables.approval_stage_tracking.rows).toBe(dataset?.stages);
      }
    }
    // Volume never sees stages; Throughput never sees requests.
    expect(ready(gateMetricLoad("request_volume", result)).tables).not.toHaveProperty(
      "approval_stage_tracking",
    );
    expect(ready(gateMetricLoad("queue_throughput", result)).tables).not.toHaveProperty(
      "financial_requests",
    );
  });

  it("treats complete empty tables as data, not as a failed load", () => {
    const result = load(complete([]), complete([]));
    for (const id of EFFICIENCY_METRIC_IDS) {
      const gate = ready(gateMetricLoad(id, result));
      for (const table of Object.values(gate.tables)) expect(table?.rows).toEqual([]);
    }
    // An empty complete request table stays usable even when the stage read fails.
    const partial = load(complete([]), failed("unavailable"));
    expect(
      ready(gateMetricLoad("request_volume", partial)).tables.financial_requests?.rows,
    ).toEqual([]);
  });

  it("cancels every metric when either read was cancelled", () => {
    for (const result of [
      load(cancelled(), complete(stageRows)),
      load(complete(requestRows), cancelled()),
      { status: "cancelled" } as const,
    ]) {
      for (const id of EFFICIENCY_METRIC_IDS) {
        expect(gateMetricLoad(id, result)).toEqual({ status: "cancelled", metricId: id });
      }
    }
  });

  it("lets Request Volume calculate when only the stage read failed", () => {
    const result = load(complete(requestRows), failed("access"));
    const gate = ready(gateMetricLoad("request_volume", result));
    expect(gate.tables.financial_requests?.rows).toEqual(requestRows);
    expect(gate.tables).not.toHaveProperty("approval_stage_tracking");
  });

  it("lets Queue Throughput calculate when only the request read failed", () => {
    const result = load(failed("unavailable"), complete(stageRows));
    const gate = ready(gateMetricLoad("queue_throughput", result));
    expect(gate.tables.approval_stage_tracking?.rows).toEqual(stageRows);
    expect(gate.tables).not.toHaveProperty("financial_requests");
  });

  it("lets Volume and Throughput calculate when only stage_request_not_loaded applies", () => {
    const orphan = stage("req-not-loaded", 1, 1);
    const result = load(complete(requestRows), complete([...stageRows, orphan]));
    expect(result.status === "blocked" && result.errors).toEqual(["stage_request_not_loaded"]);
    expect(ready(gateMetricLoad("request_volume", result)).tables.financial_requests?.rows).toEqual(
      requestRows,
    );
    expect(
      ready(gateMetricLoad("queue_throughput", result)).tables.approval_stage_tracking?.rows,
    ).toContain(orphan);
    for (const id of BOTH_TABLES) {
      expect(blocked(gateMetricLoad(id, result))).toMatchObject({
        errors: ["stage_request_not_loaded"],
        incompleteTables: [],
        issue: null,
      });
    }
  });

  it("blocks metrics needing both tables when either table is not complete", () => {
    const cases: [
      TableReadResult<EfficiencyRequestRow>,
      TableReadResult<EfficiencyStageRow>,
      string,
      string,
    ][] = [
      [failed("access"), complete(stageRows), "request_read_failed", "financial_requests"],
      [incomplete(), complete(stageRows), "request_read_incomplete", "financial_requests"],
      [
        fieldMissing("created_at"),
        complete(stageRows),
        "request_field_missing",
        "financial_requests",
      ],
      [
        complete(requestRows),
        failed("unavailable"),
        "stage_read_failed",
        "approval_stage_tracking",
      ],
      [complete(requestRows), incomplete(), "stage_read_incomplete", "approval_stage_tracking"],
      [
        complete(requestRows),
        fieldMissing("workflow_revision"),
        "stage_field_missing",
        "approval_stage_tracking",
      ],
    ];
    for (const [requests, stages, code, table] of cases) {
      const result = load(requests, stages);
      for (const id of BOTH_TABLES) {
        const gate = blocked(gateMetricLoad(id, result));
        expect(gate.errors).toEqual([code]);
        expect(gate.incompleteTables).toEqual([table]);
        expect(gate.loadErrors).toEqual([code]);
      }
    }
  });

  it("blocks Volume and Throughput on their own table's failures", () => {
    const requestsFailed = load(fieldMissing("created_at"), complete(stageRows));
    expect(blocked(gateMetricLoad("request_volume", requestsFailed))).toMatchObject({
      errors: ["request_field_missing"],
      incompleteTables: ["financial_requests"],
      issue: null,
    });
    const stagesIncomplete = load(complete(requestRows), incomplete());
    expect(blocked(gateMetricLoad("queue_throughput", stagesIncomplete))).toMatchObject({
      errors: ["stage_read_incomplete"],
      incompleteTables: ["approval_stage_tracking"],
    });
  });

  it("keeps the read issue only for a metric whose own table failed", () => {
    const stageAccess = load(complete(requestRows), failed("access"));
    expect(blocked(gateMetricLoad("queue_throughput", stageAccess)).issue).toEqual({
      kind: "access",
      message: "access message",
    });
    expect(blocked(gateMetricLoad("approval_rate", stageAccess)).issue?.kind).toBe("access");

    // F19.3 classifies only the first failed read (requests). It must not be
    // reported as the stage read's issue.
    const bothFailed = load(failed("access"), failed("unavailable"));
    expect(blocked(gateMetricLoad("request_volume", bothFailed)).issue?.kind).toBe("access");
    const throughput = blocked(gateMetricLoad("queue_throughput", bothFailed));
    expect(throughput.issue).toBeNull();
    expect(throughput.errors).toEqual(["stage_read_failed"]);
    expect(throughput.loadErrors).toEqual(["request_read_failed", "stage_read_failed"]);
    const workload = blocked(gateMetricLoad("active_queue_workload", bothFailed));
    expect(workload.errors).toEqual(["request_read_failed", "stage_read_failed"]);
    expect(workload.incompleteTables).toEqual(["financial_requests", "approval_stage_tracking"]);
  });

  it("follows the catalog's requiredReads and loadIntegrityErrors for every metric and failure", () => {
    const requestReads = [
      complete(requestRows),
      failed<EfficiencyRequestRow>("access"),
      incomplete<EfficiencyRequestRow>(),
      fieldMissing<EfficiencyRequestRow>("status"),
    ];
    const stageReads = [
      complete(stageRows),
      complete([...stageRows, stage("ghost", 1, 1)]),
      failed<EfficiencyStageRow>("unavailable"),
      incomplete<EfficiencyStageRow>(),
      fieldMissing<EfficiencyStageRow>("queue_id"),
    ];
    for (const requests of requestReads) {
      for (const stages of stageReads) {
        const result = load(requests, stages);
        const loadErrors = result.status === "blocked" ? result.errors : [];
        for (const id of EFFICIENCY_METRIC_IDS) {
          const metric = EFFICIENCY_METRICS[id];
          const applies = metric.loadIntegrityErrors.filter((code) => loadErrors.includes(code));
          const gate = gateMetricLoad(id, result);
          expect(gate.status).toBe(applies.length > 0 ? "blocked" : "ready");
          if (gate.status === "blocked") expect(gate.errors).toEqual(applies);
        }
      }
    }
  });

  it("still blocks a metric whose required table is missing when no listed error explains it", () => {
    // Not produced by checkDatasetIntegrity; guards against an inconsistent load.
    const inconsistent: DatasetIntegrityResult = {
      status: "blocked",
      errors: ["stage_read_failed"],
      issue: null,
      completeTables: { financial_requests: null, approval_stage_tracking: null },
    };
    expect(blocked(gateMetricLoad("request_volume", inconsistent))).toMatchObject({
      errors: [],
      incompleteTables: ["financial_requests"],
    });
  });

  it("never turns a blocked metric into a value, zero or no-data", () => {
    const result = load(failed("access"), failed("access"));
    for (const id of EFFICIENCY_METRIC_IDS) {
      const gate = blocked(gateMetricLoad(id, result));
      expect(Object.keys(gate).sort()).toEqual(
        ["errors", "incompleteTables", "issue", "loadErrors", "metricId", "status"].sort(),
      );
      expect(gate.errors.length).toBeGreaterThan(0);
    }
  });

  it("gates every catalog metric at once, in catalog order", () => {
    const result = load(complete(requestRows), failed("unavailable"));
    const gates = gateAllMetrics(result);
    expect(Object.keys(gates)).toEqual([...EFFICIENCY_METRIC_IDS]);
    for (const id of EFFICIENCY_METRIC_IDS) expect(gates[id]).toEqual(gateMetricLoad(id, result));
    expect(gates.request_volume.status).toBe("ready");
    expect(gates.queue_throughput.status).toBe("blocked");
    expect(Object.isFrozen(gates)).toBe(true);
  });

  it("does not modify the load and returns frozen results", () => {
    const result = load(complete(requestRows), failed("access"));
    const before = snapshot(result);
    const gates = EFFICIENCY_METRIC_IDS.map((id) => gateMetricLoad(id, result));
    expect(snapshot(result)).toEqual(before);
    for (const gate of gates) {
      expect(Object.isFrozen(gate)).toBe(true);
      if (gate.status === "ready") expect(Object.isFrozen(gate.tables)).toBe(true);
      if (gate.status === "blocked") {
        expect(Object.isFrozen(gate.errors)).toBe(true);
        expect(Object.isFrozen(gate.incompleteTables)).toBe(true);
        expect(Object.isFrozen(gate.loadErrors)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

describe("module boundaries", () => {
  const source = read("./efficiency-population.ts");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);

  it("imports only the F19.3 types, the catalog and routing", () => {
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-data",
      "@/lib/efficiency-metrics",
      "@/lib/routing/rules",
    ]);
    // The data layer is imported for types only, so its runtime code is not pulled in.
    expect(imports[0]).toMatch(/^import type /);
    expect(source).not.toMatch(/supabase|efficiency-data-loader|react/i);
    // Gating and classification import this module, so it must not import them back.
    expect(source).not.toMatch(/from\s+"[^"]*efficiency-classification"/);
  });

  it("is not imported by the catalog, the data layer, the stats helpers, routing or F18 modules", () => {
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-data-loader.ts",
      "./efficiency-stats.ts",
      "./routing/rules.ts",
      "./time-zones.ts",
      "./reporting-periods.ts",
      "./date-range-filter.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-population/);
    }
  });
});
