import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controlled fakes for the two existing clients. Each records every query it
// builds and answers from in-memory tables, honouring the keyset contract
// (id > after, ascending, limit) and head-only exact counts. A per-test hook
// can override any response. No network, no timers.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Filter = readonly [op: string, column: string, value: unknown];
  type Call = {
    client: "supabase" | "approvalStageClient";
    table: string;
    select: string;
    options: { count?: string; head?: boolean } | undefined;
    filters: Filter[];
    order: { column: string; ascending: boolean | undefined } | undefined;
    limit: number | undefined;
    signal: AbortSignal | undefined;
  };
  type Response = { data?: unknown; error?: unknown; count?: number | null };

  const state = {
    calls: [] as Call[],
    tables: {} as Record<string, Row[]>,
    hook: undefined as ((call: Call) => Response | undefined) | undefined,
  };

  const serve = (call: Call): Required<Response> => {
    state.calls.push(call);
    const override = state.hook?.(call);
    if (override) return { data: null, error: null, count: null, ...override };
    // Apply every recorded filter, as PostgREST would, so an unexpected
    // filter visibly changes counts and pages.
    const matches = (row: Row) =>
      call.filters.every(([op, column, value]) => {
        if (op === "gt") return String(row[column]) > String(value);
        if (op === "eq") return row[column] === value;
        if (op === "in") return Array.isArray(value) && value.includes(row[column]);
        return false;
      });
    const rows = [...(state.tables[call.table] ?? [])]
      .filter(matches)
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    if (call.options?.head) return { data: null, error: null, count: rows.length };
    const columns = call.select.split(",");
    const page = rows
      .slice(0, call.limit ?? Number.POSITIVE_INFINITY)
      .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    return { data: page, error: null, count: null };
  };

  const makeClient = (client: Call["client"]) => ({
    from(table: string) {
      const call: Call = {
        client,
        table,
        select: "",
        options: undefined,
        filters: [],
        order: undefined,
        limit: undefined,
        signal: undefined,
      };
      const builder = {
        select(columns: string, options?: Call["options"]) {
          call.select = columns;
          call.options = options;
          return builder;
        },
        gt(column: string, value: unknown) {
          call.filters.push(["gt", column, value]);
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value]);
          return builder;
        },
        in(column: string, value: unknown) {
          call.filters.push(["in", column, value]);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          call.order = { column, ascending: options?.ascending };
          return builder;
        },
        limit(count: number) {
          call.limit = count;
          return builder;
        },
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return builder;
        },
        then<T1, T2>(
          onFulfilled?: (value: Required<Response>) => T1 | PromiseLike<T1>,
          onRejected?: (reason: unknown) => T2 | PromiseLike<T2>,
        ) {
          return Promise.resolve()
            .then(() => serve(call))
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  });

  return {
    state,
    supabase: makeClient("supabase"),
    approvalStageClient: makeClient("approvalStageClient"),
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: fake.supabase }));
vi.mock("@/lib/approval-stage-client", () => ({
  approvalStageClient: fake.approvalStageClient,
}));

import {
  DEFAULT_MAX_ATTEMPTS,
  EFFICIENCY_REQUEST_SELECT,
  EFFICIENCY_STAGE_SELECT,
  RACE_INCOMPLETE_REASONS,
  isRetryableLoad,
  loadEfficiencyDataset,
  type EfficiencyLoadResult,
} from "./efficiency-data-loader";
import {
  DEFAULT_PAGE_SIZE,
  EFFICIENCY_REQUEST_COLUMNS,
  EFFICIENCY_STAGE_COLUMNS,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type TableReadResult,
} from "./efficiency-data";
import { classifyRequestReadError } from "./request-list";

type Call = (typeof fake.state.calls)[number];

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const REQUESTS = "financial_requests";
const STAGES = "approval_stage_tracking";
const USER = "user-123";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** Stored rows carry extra person-level columns the loader must never select. */
const requestRow = (n: number) => ({
  id: uuid(n),
  status: "under_review",
  created_at: "2026-11-02T12:00:00.000000+00:00",
  user_id: "owner-secret",
  requester_email: "owner@example.edu",
  title: "Lab equipment",
});

const stageRow = (n: number, requestN: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(1000 + n),
  request_id: uuid(requestN),
  workflow_revision: 1,
  stage_order: 1,
  queue_id: "department_budget",
  status: "completed",
  started_at: "2026-11-02T12:00:00.000000+00:00",
  completed_at: "2026-11-03T12:00:00.000000+00:00",
  stage_name: "Department Budget",
  deadline_at: "2026-11-05T12:00:00.000000+00:00",
  duration_hours: 72,
  ...overrides,
});

/** Three requests; four stages covering every status and two workflow revisions. */
function seed() {
  fake.state.tables = {
    [REQUESTS]: [3, 1, 2].map(requestRow),
    [STAGES]: [
      stageRow(1, 1),
      stageRow(2, 1, { stage_order: 2, status: "cancelled", queue_id: "dean_office" }),
      stageRow(3, 1, { workflow_revision: 2, status: "active", completed_at: null }),
      stageRow(4, 2, { status: "skipped" }),
    ],
  };
}

beforeEach(() => {
  fake.state.calls = [];
  fake.state.hook = undefined;
  seed();
});

const calls = (table: string) => fake.state.calls.filter((call) => call.table === table);
const isHead = (call: Call) => call.options?.head === true;
const pages = (table: string) => calls(table).filter((call) => !isHead(call));
const counts = (table: string) => calls(table).filter(isHead);
const cursor = (call: Call) => call.filters.find(([op]) => op === "gt")?.[2] ?? null;
/** Which head-count call this is for its table (1-based), counting the current call. */
const countIndex = (call: Call) => counts(call.table).length;
const attemptsMade = () => counts(REQUESTS).length / 2;

const load = (options: { signal?: AbortSignal; pageSize?: number; maxAttempts?: number } = {}) =>
  loadEfficiencyDataset({
    userId: USER,
    signal: options.signal ?? new AbortController().signal,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

/** A count-mismatch race on `table`: the second count of every read is one higher. */
const countMismatchOn =
  (table: string, onAttempts: (attempt: number) => boolean = () => true) =>
  (call: Call) => {
    if (call.table !== table || !isHead(call)) return undefined;
    const index = countIndex(call);
    const attempt = Math.ceil(index / 2);
    if (index % 2 === 0 && onAttempts(attempt)) {
      return { count: (fake.state.tables[table]?.length ?? 0) + 1 };
    }
    return undefined;
  };

const ACCESS_ERROR = { code: "42501", message: "permission denied for table" };
const OUTAGE_ERROR = { status: 503, message: "Service Unavailable" };

function expectNoDataset(result: EfficiencyLoadResult) {
  expect(result.status).not.toBe("complete");
  expect(result).not.toHaveProperty("dataset");
}

// ---------------------------------------------------------------------------
// A. Query construction
// ---------------------------------------------------------------------------

describe("query construction", () => {
  it("reads financial_requests only through the shared supabase client", async () => {
    await load({ pageSize: 2 });
    expect(calls(REQUESTS).length).toBeGreaterThan(0);
    expect(calls(REQUESTS).every((call) => call.client === "supabase")).toBe(true);
  });

  it("reads approval_stage_tracking only through approvalStageClient", async () => {
    await load({ pageSize: 2 });
    expect(calls(STAGES).length).toBeGreaterThan(0);
    expect(calls(STAGES).every((call) => call.client === "approvalStageClient")).toBe(true);
  });

  it("queries no other table", async () => {
    await load();
    expect(new Set(fake.state.calls.map((call) => call.table))).toEqual(
      new Set([REQUESTS, STAGES]),
    );
  });

  it("selects exactly the exported column constants on every page", async () => {
    await load({ pageSize: 2 });
    expect(EFFICIENCY_REQUEST_SELECT).toBe(EFFICIENCY_REQUEST_COLUMNS.join(","));
    expect(EFFICIENCY_STAGE_SELECT).toBe(EFFICIENCY_STAGE_COLUMNS.join(","));
    expect(pages(REQUESTS).every((call) => call.select === EFFICIENCY_REQUEST_SELECT)).toBe(true);
    expect(pages(STAGES).every((call) => call.select === EFFICIENCY_STAGE_SELECT)).toBe(true);
  });

  it("includes the stage pagination id and workflow_revision, and no person-level column", async () => {
    await load();
    const stageColumns = pages(STAGES)[0].select.split(",");
    expect(stageColumns).toContain("id");
    expect(stageColumns).toContain("workflow_revision");
    for (const call of fake.state.calls) {
      expect(call.select).not.toMatch(/user|email|actor|requester|reviewer|assign|title|\*/);
    }
  });

  it("applies no status or other filter, only the id cursor", async () => {
    await load({ pageSize: 2 });
    for (const call of fake.state.calls) {
      for (const [op, column] of call.filters) {
        expect([op, column]).toEqual(["gt", "id"]);
      }
    }
    expect(
      calls(STAGES).some((call) => call.filters.some(([, column]) => column === "status")),
    ).toBe(false);
  });

  it("pages both tables by id ascending with the configured page size", async () => {
    await load({ pageSize: 2 });
    for (const call of [...pages(REQUESTS), ...pages(STAGES)]) {
      expect(call.order).toEqual({ column: "id", ascending: true });
      expect(call.limit).toBe(2);
    }
  });

  it("uses DEFAULT_PAGE_SIZE when pageSize is omitted", async () => {
    await load();
    expect(pages(REQUESTS)[0].limit).toBe(DEFAULT_PAGE_SIZE);
    expect(pages(STAGES)[0].limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it("advances the cursor with gt('id', after) from the second page on", async () => {
    await load({ pageSize: 2 });
    expect(pages(REQUESTS).map(cursor)).toEqual([null, uuid(2), uuid(3)]);
    expect(pages(STAGES).map(cursor)).toEqual([null, uuid(1002), uuid(1004)]);
  });

  it("takes an exact head-only count before and after paging each table", async () => {
    await load({ pageSize: 2 });
    for (const table of [REQUESTS, STAGES]) {
      const tableCalls = calls(table);
      expect(isHead(tableCalls[0])).toBe(true);
      expect(isHead(tableCalls[tableCalls.length - 1])).toBe(true);
      expect(counts(table)).toHaveLength(2);
      for (const call of counts(table)) {
        expect(call.options).toEqual({ count: "exact", head: true });
        expect(call.select).toBe("id");
      }
    }
  });

  it("passes the supplied AbortSignal to every query", async () => {
    const controller = new AbortController();
    await load({ signal: controller.signal, pageSize: 2 });
    expect(fake.state.calls.length).toBeGreaterThan(0);
    for (const call of fake.state.calls) expect(call.signal).toBe(controller.signal);
  });

  it("finishes the request read before the stage read starts", async () => {
    await load({ pageSize: 2 });
    const tables = fake.state.calls.map((call) => call.table);
    const firstStage = tables.indexOf(STAGES);
    expect(firstStage).toBeGreaterThan(0);
    expect(tables.slice(0, firstStage).every((table) => table === REQUESTS)).toBe(true);
    expect(tables.slice(firstStage).every((table) => table === STAGES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Successful loads
// ---------------------------------------------------------------------------

describe("successful loads", () => {
  it("returns a complete per-table-validated dataset with userId and one attempt", async () => {
    const result = await load({ pageSize: 2 });
    expect(result).toMatchObject({
      status: "complete",
      userId: USER,
      attempts: 1,
      dataset: { consistency: "per-table-validated" },
    });
    expect(JSON.stringify(result)).not.toMatch(/snapshot/i);
  });

  it("returns every row of both tables in id order, projected to the selected columns", async () => {
    const result = await load({ pageSize: 2 });
    if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
    expect(result.dataset.requests.map((row) => row.id)).toEqual([1, 2, 3].map(uuid));
    expect(result.dataset.stages.map((row) => row.id)).toEqual(
      [1, 2, 3, 4].map((n) => uuid(1000 + n)),
    );
    for (const row of result.dataset.requests) {
      expect(Object.keys(row).sort()).toEqual([...EFFICIENCY_REQUEST_COLUMNS].sort());
    }
    for (const row of result.dataset.stages) {
      expect(Object.keys(row).sort()).toEqual([...EFFICIENCY_STAGE_COLUMNS].sort());
    }
  });

  it("loads every stage status and every workflow revision", async () => {
    const result = await load();
    if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
    expect(new Set(result.dataset.stages.map((row) => row.status))).toEqual(
      new Set(["completed", "cancelled", "active", "skipped"]),
    );
    expect(new Set(result.dataset.stages.map((row) => row.workflow_revision))).toEqual(
      new Set([1, 2]),
    );
  });

  it("loads empty tables as complete", async () => {
    fake.state.tables = { [REQUESTS]: [], [STAGES]: [] };
    const result = await load();
    expect(result).toMatchObject({
      status: "complete",
      attempts: 1,
      dataset: { requests: [], stages: [] },
    });
    expect(pages(REQUESTS)).toHaveLength(1);
    expect(pages(STAGES)).toHaveLength(1);
  });

  it("records a read window for each table", async () => {
    const result = await load();
    if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
    for (const window of Object.values(result.dataset.reads)) {
      expect(Date.parse(window.readStartedAt)).not.toBeNaN();
      expect(Date.parse(window.readCompletedAt)).toBeGreaterThanOrEqual(
        Date.parse(window.readStartedAt),
      );
    }
  });

  it("adds no prototype rows", async () => {
    const result = await load();
    if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
    expect(result.dataset.requests).toHaveLength(3);
    for (const row of [...result.dataset.requests, ...result.dataset.stages]) {
      expect(row).not.toHaveProperty("prototype");
    }
  });
});

// ---------------------------------------------------------------------------
// C. Independent table availability
// ---------------------------------------------------------------------------

describe("independent table availability", () => {
  it("keeps the complete stage table when the request read fails, still reading stages", async () => {
    fake.state.hook = (call) =>
      call.table === REQUESTS && !isHead(call) && cursor(call) !== null
        ? { error: ACCESS_ERROR }
        : undefined;
    const result = await load({ pageSize: 2 });
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["request_read_failed"],
      issue: classifyRequestReadError(ACCESS_ERROR),
    });
    if (result.status !== "blocked") return;
    expect(result.completeTables.financial_requests).toBeNull();
    expect(result.completeTables.approval_stage_tracking?.rows).toHaveLength(4);
    expect(calls(STAGES).length).toBeGreaterThan(0);
    expectNoDataset(result);
  });

  it("keeps the complete request table when the stage read fails", async () => {
    fake.state.hook = (call) =>
      call.table === STAGES && !isHead(call) ? { error: OUTAGE_ERROR } : undefined;
    const result = await load();
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["stage_read_failed"],
      issue: { kind: "unavailable" },
    });
    if (result.status !== "blocked") return;
    expect(result.completeTables.financial_requests?.rows).toHaveLength(3);
    expect(result.completeTables.approval_stage_tracking).toBeNull();
  });

  it("never exposes rows already read from a table whose later page failed", async () => {
    fake.state.hook = (call) =>
      call.table === STAGES && !isHead(call) && cursor(call) !== null
        ? { error: OUTAGE_ERROR }
        : undefined;
    const result = await load({ pageSize: 2 });
    expect(result).toMatchObject({ status: "blocked", errors: ["stage_read_failed"] });
    if (result.status !== "blocked") return;
    expect(result.completeTables.approval_stage_tracking).toBeNull();
    expect(JSON.stringify(result)).not.toContain(uuid(1001));
  });

  it("does not substitute an empty table for a query error", async () => {
    fake.state.hook = (call) => (call.table === STAGES ? { error: OUTAGE_ERROR } : undefined);
    const result = await load();
    expect(result.status).toBe("blocked");
    if (result.status === "blocked")
      expect(result.completeTables.approval_stage_tracking).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. Retry policy
// ---------------------------------------------------------------------------

describe("retry policy", () => {
  it("defaults to two attempts in total", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(2);
    expect([...RACE_INCOMPLETE_REASONS]).toEqual(["count_mismatch"]);
  });

  it("retries a request count mismatch and returns the second attempt", async () => {
    fake.state.hook = countMismatchOn(REQUESTS, (attempt) => attempt === 1);
    const result = await load();
    expect(result).toMatchObject({ status: "complete", attempts: 2, userId: USER });
    expect(attemptsMade()).toBe(2);
  });

  it("retries a stage count mismatch", async () => {
    fake.state.hook = countMismatchOn(STAGES, (attempt) => attempt === 1);
    const result = await load();
    expect(result).toMatchObject({ status: "complete", attempts: 2 });
  });

  it("retries stage_request_not_loaded for a request created between the two reads", async () => {
    let inserted = false;
    fake.state.hook = (call) => {
      if (!inserted && call.table === STAGES) {
        inserted = true;
        fake.state.tables[REQUESTS].push(requestRow(9));
        fake.state.tables[STAGES].push(stageRow(9, 9, { status: "active", completed_at: null }));
      }
      return undefined;
    };
    const result = await load();
    expect(result).toMatchObject({ status: "complete", attempts: 2 });
    if (result.status === "complete") expect(result.dataset.requests).toHaveLength(4);
  });

  it("returns the final blocked result when retries are exhausted", async () => {
    fake.state.hook = countMismatchOn(REQUESTS);
    const result = await load();
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 2,
      errors: ["request_read_incomplete"],
      issue: null,
    });
    expect(attemptsMade()).toBe(2);
    if (result.status === "blocked") {
      expect(result.completeTables.financial_requests).toBeNull();
      expect(result.completeTables.approval_stage_tracking?.rows).toHaveLength(4);
    }
  });

  it.each([1, 3])("honours maxAttempts = %i", async (maxAttempts) => {
    fake.state.hook = countMismatchOn(REQUESTS);
    const result = await load({ maxAttempts });
    expect(result).toMatchObject({ status: "blocked", attempts: maxAttempts });
    expect(attemptsMade()).toBe(maxAttempts);
  });

  it.each([
    ["an access error", ACCESS_ERROR, "access"],
    ["an availability error", OUTAGE_ERROR, "unavailable"],
  ])("does not retry %s", async (_case, error, kind) => {
    fake.state.hook = (call) => (call.table === STAGES && !isHead(call) ? { error } : undefined);
    const result = await load();
    expect(result).toMatchObject({ status: "blocked", attempts: 1, issue: { kind } });
    expect(attemptsMade()).toBe(1);
  });

  it("does not retry a count request error", async () => {
    fake.state.hook = (call) =>
      call.table === REQUESTS && isHead(call) ? { error: OUTAGE_ERROR } : undefined;
    const result = await load();
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["request_read_failed"],
    });
  });

  it("does not retry a missing field", async () => {
    fake.state.hook = (call) => {
      if (call.table !== STAGES || isHead(call) || cursor(call) !== null) return undefined;
      const { workflow_revision: _revision, ...row } = stageRow(1, 1);
      return { data: [row] };
    };
    fake.state.tables[STAGES] = [stageRow(1, 1)];
    const result = await load();
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["stage_field_missing"],
    });
    expect(attemptsMade()).toBe(1);
  });

  it.each([
    [
      "count_unavailable",
      (call: Call) => (call.table === STAGES && isHead(call) ? { count: null } : undefined),
    ],
    [
      "duplicate_key",
      (call: Call) =>
        call.table === STAGES && !isHead(call) && cursor(call) === null
          ? { data: [stageRow(1, 1), stageRow(1, 1)] }
          : undefined,
    ],
    [
      "page_overflow",
      (call: Call) =>
        call.table === STAGES && !isHead(call) && cursor(call) === null
          ? { data: [stageRow(1, 1), stageRow(2, 1), stageRow(3, 1)] }
          : undefined,
    ],
  ])("does not retry the non-race incomplete reason %s", async (_reason, hook) => {
    fake.state.hook = hook;
    const result = await load({ pageSize: 2 });
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["stage_read_incomplete"],
    });
    expect(attemptsMade()).toBe(1);
  });

  it("does not retry when a race error is mixed with a non-race error", async () => {
    const race = countMismatchOn(REQUESTS);
    fake.state.hook = (call) =>
      race(call) ?? (call.table === STAGES && !isHead(call) ? { error: ACCESS_ERROR } : undefined);
    const result = await load();
    expect(result).toMatchObject({
      status: "blocked",
      attempts: 1,
      errors: ["request_read_incomplete", "stage_read_failed"],
      issue: { kind: "access" },
    });
    expect(attemptsMade()).toBe(1);
  });

  it("does not retry after cancellation, even when the attempt had a race", async () => {
    const controller = new AbortController();
    const race = countMismatchOn(REQUESTS);
    fake.state.hook = (call) => {
      if (call.table === STAGES && !isHead(call)) controller.abort();
      return race(call);
    };
    const result = await load({ signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 1 });
    expect(attemptsMade()).toBe(1);
  });

  it.each([
    ["an empty userId", { userId: "" }],
    ["a non-string userId", { userId: 42 as unknown as string }],
    ["pageSize 0", { pageSize: 0 }],
    ["a fractional pageSize", { pageSize: 1.5 }],
    ["maxAttempts 0", { maxAttempts: 0 }],
    ["a fractional maxAttempts", { maxAttempts: 2.5 }],
  ])("throws RangeError for %s before any query", async (_case, overrides) => {
    await expect(
      loadEfficiencyDataset({ userId: USER, signal: new AbortController().signal, ...overrides }),
    ).rejects.toThrow(RangeError);
    expect(fake.state.calls).toHaveLength(0);
  });
});

describe("isRetryableLoad", () => {
  const WINDOW = {
    readStartedAt: "2026-11-19T10:00:00.000Z",
    readCompletedAt: "2026-11-19T10:00:01.000Z",
  };
  const complete = <Row>(): TableReadResult<Row> => ({
    status: "complete",
    rows: [],
    expectedCount: 0,
    pagesRead: 1,
    window: WINDOW,
  });
  const incomplete = <Row>(reason: "count_mismatch" | "duplicate_key"): TableReadResult<Row> => ({
    status: "incomplete",
    reason,
    counts: { expectedBefore: 1, expectedAfter: 2, collected: 1 },
    pagesRead: 2,
  });
  const failed = <Row>(): TableReadResult<Row> => ({
    status: "failed",
    error: OUTAGE_ERROR,
    issue: classifyRequestReadError(OUTAGE_ERROR),
    pagesRead: 1,
  });
  const blocked = (errors: Extract<DatasetIntegrityResult, { status: "blocked" }>["errors"]) =>
    ({
      status: "blocked",
      errors,
      issue: null,
      completeTables: { financial_requests: null, approval_stage_tracking: null },
    }) as DatasetIntegrityResult;
  const check = (
    requests: TableReadResult<EfficiencyRequestRow>,
    stages: TableReadResult<EfficiencyStageRow>,
    integrity: DatasetIntegrityResult,
  ) => isRetryableLoad({ requests, stages, integrity });

  it("is false for complete and cancelled results", () => {
    const dataset = {
      requests: [],
      stages: [],
      consistency: "per-table-validated" as const,
      reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
    };
    expect(check(complete(), complete(), { status: "complete", dataset })).toBe(false);
    expect(check(complete(), complete(), { status: "cancelled" })).toBe(false);
  });

  it("is true only for race-related errors", () => {
    expect(
      check(incomplete("count_mismatch"), complete(), blocked(["request_read_incomplete"])),
    ).toBe(true);
    expect(
      check(complete(), incomplete("count_mismatch"), blocked(["stage_read_incomplete"])),
    ).toBe(true);
    expect(check(complete(), complete(), blocked(["stage_request_not_loaded"]))).toBe(true);
    expect(
      check(
        incomplete("count_mismatch"),
        incomplete("count_mismatch"),
        blocked(["request_read_incomplete", "stage_read_incomplete"]),
      ),
    ).toBe(true);
  });

  it("is false for non-race incomplete reasons, failures, missing fields, mixes and no errors", () => {
    expect(
      check(incomplete("duplicate_key"), complete(), blocked(["request_read_incomplete"])),
    ).toBe(false);
    expect(check(failed(), complete(), blocked(["request_read_failed"]))).toBe(false);
    expect(check(complete(), complete(), blocked(["stage_field_missing"]))).toBe(false);
    expect(
      check(
        incomplete("count_mismatch"),
        failed(),
        blocked(["request_read_incomplete", "stage_read_failed"]),
      ),
    ).toBe(false);
    expect(check(complete(), complete(), blocked([]))).toBe(false);
  });

  it("does not trust an incomplete code whose table read was not a count mismatch", () => {
    expect(check(complete(), complete(), blocked(["stage_read_incomplete"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. Identity and cancellation
// ---------------------------------------------------------------------------

describe("identity and cancellation", () => {
  it("keeps the same userId across retries and does not send it to the database", async () => {
    fake.state.hook = countMismatchOn(REQUESTS, (attempt) => attempt === 1);
    const result = await load();
    expect(result).toMatchObject({ status: "complete", attempts: 2, userId: USER });
    for (const call of fake.state.calls) {
      expect(JSON.stringify(call.filters)).not.toContain(USER);
    }
  });

  it("makes zero queries for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await load({ signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 0 });
    expect(fake.state.calls).toHaveLength(0);
  });

  it("does not start the stage read when cancelled during the request read", async () => {
    const controller = new AbortController();
    fake.state.hook = (call) => {
      if (call.table === REQUESTS && !isHead(call) && cursor(call) !== null) controller.abort();
      return undefined;
    };
    const result = await load({ signal: controller.signal, pageSize: 2 });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 1 });
    expect(calls(STAGES)).toHaveLength(0);
    expect(pages(REQUESTS)).toHaveLength(2);
  });

  it("stops at the abort during the stage read and starts no retry", async () => {
    const controller = new AbortController();
    fake.state.hook = (call) => {
      if (call.table === STAGES && !isHead(call) && cursor(call) !== null) controller.abort();
      return undefined;
    };
    const result = await load({ signal: controller.signal, pageSize: 2 });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 1 });
    expect(pages(STAGES)).toHaveLength(2);
    expect(counts(STAGES)).toHaveLength(1);
    expect(attemptsMade()).toBe(1);
  });

  it("returns cancelled, not a dataset, when aborted during the very last count", async () => {
    const controller = new AbortController();
    fake.state.hook = (call) => {
      if (call.table === STAGES && isHead(call) && countIndex(call) === 2) controller.abort();
      return undefined;
    };
    const result = await load({ signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 1 });
    expectNoDataset(result);
  });

  it("returns cancelled, not failed, when an aborted query reports an AbortError", async () => {
    const controller = new AbortController();
    fake.state.hook = (call) => {
      if (call.table !== REQUESTS || isHead(call)) return undefined;
      controller.abort();
      return { error: { name: "AbortError", message: "The operation was aborted." } };
    };
    const result = await load({ signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", userId: USER, attempts: 1 });
  });
});
