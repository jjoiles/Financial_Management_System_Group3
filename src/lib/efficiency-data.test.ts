import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  EFFICIENCY_REQUEST_COLUMNS,
  EFFICIENCY_STAGE_COLUMNS,
  PAGINATION_KEY,
  checkDatasetIntegrity,
  checkRequiredFields,
  findMissingField,
  readAllPages,
  type CountResponse,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type FetchCount,
  type FetchPage,
  type PageResponse,
  type ReadAllPagesOptions,
  type TableReadResult,
} from "./efficiency-data";
import { LOAD_INTEGRITY_ERROR_CODES, SOURCE_FIELDS } from "./efficiency-metrics";
import { classifyRequestReadError } from "./request-list";

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

/** Lowercase, zero-padded UUIDs whose text order matches their numeric order. */
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const requestRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(n),
  status: "submitted",
  created_at: "2026-11-02T12:00:00.000000+00:00",
  ...overrides,
});

const stageRow = (n: number, requestN: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(1000 + n),
  request_id: uuid(requestN),
  workflow_revision: 1,
  stage_order: 1,
  queue_id: "department_budget",
  status: "active",
  started_at: "2026-11-02T12:00:00.000000+00:00",
  completed_at: null,
  ...overrides,
});

const WINDOW = Object.freeze({
  readStartedAt: "2026-11-19T10:00:00.000Z",
  readCompletedAt: "2026-11-19T10:00:01.000Z",
});

const signal = () => new AbortController().signal;

type FakeTableOptions = {
  /** Server-side row cap; a page never returns more than min(limit, cap) rows. */
  readonly cap?: number;
  /** Counts returned by successive fetchCount calls; defaults to the row count. */
  readonly counts?: readonly (number | null)[];
};

/** An in-memory table that honours the keyset contract: key > after, ascending, limit. */
function fakeTable(rows: readonly Record<string, unknown>[], options: FakeTableOptions = {}) {
  const sorted = [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  const cap = options.cap ?? Number.POSITIVE_INFINITY;
  let countCall = 0;
  const fetchPage = vi.fn<FetchPage>(async ({ after, limit }) => ({
    data: sorted
      .filter((row) => after === null || String(row.id) > after)
      .slice(0, Math.min(limit, cap)),
    error: null,
  }));
  const fetchCount = vi.fn<FetchCount>(async () => {
    const scripted = options.counts?.[countCall];
    countCall += 1;
    return { count: scripted === undefined ? rows.length : scripted, error: null };
  });
  return { fetchPage, fetchCount };
}

/** A fetchPage that returns the given pages in order, then empty pages. */
function scriptedPages(pages: readonly PageResponse[]) {
  let call = 0;
  return vi.fn<FetchPage>(async () => pages[call++] ?? { data: [], error: null });
}

const fixedCount = (count: number | null) =>
  vi.fn<FetchCount>(async () => ({ count, error: null }));

let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 19, 10, 0, clockTick++));

function readRequests(
  overrides: Partial<ReadAllPagesOptions> & Pick<ReadAllPagesOptions, "fetchPage" | "fetchCount">,
) {
  return readAllPages<EfficiencyRequestRow>({
    requiredFields: EFFICIENCY_REQUEST_COLUMNS,
    signal: signal(),
    now: clock,
    ...overrides,
  });
}

/** Every non-complete result must carry no row data at all. */
function expectNoRows(result: TableReadResult<unknown>) {
  expect(result.status).not.toBe("complete");
  expect(result).not.toHaveProperty("rows");
}

const pageAfters = (fetchPage: ReturnType<typeof vi.fn<FetchPage>>) =>
  fetchPage.mock.calls.map(([request]) => request.after);

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("columns", () => {
  it("requests exactly the request source fields, which include the id key", () => {
    expect([...EFFICIENCY_REQUEST_COLUMNS]).toEqual([...SOURCE_FIELDS.financial_requests]);
    expect(EFFICIENCY_REQUEST_COLUMNS).toContain(PAGINATION_KEY);
  });

  it("requests the stage id pagination key plus every stage source field, including workflow_revision", () => {
    expect([...EFFICIENCY_STAGE_COLUMNS]).toEqual([
      PAGINATION_KEY,
      ...SOURCE_FIELDS.approval_stage_tracking,
    ]);
    expect(EFFICIENCY_STAGE_COLUMNS).toContain("workflow_revision");
    expect(SOURCE_FIELDS.approval_stage_tracking as readonly string[]).not.toContain("id");
  });

  it("selects no person-level columns", () => {
    for (const column of [...EFFICIENCY_REQUEST_COLUMNS, ...EFFICIENCY_STAGE_COLUMNS]) {
      expect(column).not.toMatch(/user|email|actor|requester|reviewer|assign/);
    }
  });

  it("freezes the column lists", () => {
    expect(Object.isFrozen(EFFICIENCY_REQUEST_COLUMNS)).toBe(true);
    expect(Object.isFrozen(EFFICIENCY_STAGE_COLUMNS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. Required-field validation
// ---------------------------------------------------------------------------

describe("required-field validation", () => {
  it("accepts complete request and stage rows", () => {
    expect(checkRequiredFields("financial_requests", [requestRow(1), requestRow(2)])).toBeNull();
    expect(checkRequiredFields("approval_stage_tracking", [stageRow(1, 1)])).toBeNull();
    expect(checkRequiredFields("financial_requests", [])).toBeNull();
  });

  it("treats a present null or undefined value as present", () => {
    expect(checkRequiredFields("financial_requests", [requestRow(1, { created_at: null })])).toBe(
      null,
    );
    expect(
      checkRequiredFields("approval_stage_tracking", [
        stageRow(1, 1, { completed_at: null, started_at: null, workflow_revision: undefined }),
      ]),
    ).toBeNull();
  });

  it("detects a missing own property with the table-specific code", () => {
    const { created_at: _created, ...request } = requestRow(1);
    const { workflow_revision: _revision, ...stage } = stageRow(1, 1);
    expect(checkRequiredFields("financial_requests", [requestRow(2), request])).toBe(
      "request_field_missing",
    );
    expect(checkRequiredFields("approval_stage_tracking", [stage])).toBe("stage_field_missing");
  });

  it("requires the stage id pagination key even though it is not a metric source", () => {
    const { id: _id, ...stage } = stageRow(1, 1);
    expect(checkRequiredFields("approval_stage_tracking", [stage])).toBe("stage_field_missing");
  });

  it("does not accept inherited properties as present", () => {
    const inherited = Object.create({ created_at: "2026-11-02T12:00:00Z" }) as object;
    Object.assign(inherited, { id: uuid(1), status: "submitted" });
    expect(checkRequiredFields("financial_requests", [inherited])).toBe("request_field_missing");
  });

  it("handles non-object rows safely as missing every field", () => {
    for (const row of [null, undefined, 42, "row", true]) {
      expect(() => checkRequiredFields("financial_requests", [row])).not.toThrow();
      expect(checkRequiredFields("financial_requests", [row])).toBe("request_field_missing");
      expect(checkRequiredFields("approval_stage_tracking", [row])).toBe("stage_field_missing");
    }
  });

  it("reports the first missing row and field", () => {
    const rows = [requestRow(1), { id: uuid(2), created_at: null }, { id: uuid(3) }];
    expect(findMissingField(rows, EFFICIENCY_REQUEST_COLUMNS)).toEqual({
      rowIndex: 1,
      field: "status",
    });
    expect(findMissingField([requestRow(1)], EFFICIENCY_REQUEST_COLUMNS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Pagination success cases
// ---------------------------------------------------------------------------

describe("readAllPages: success", () => {
  it("reads an empty table as complete with zero rows after one empty page", async () => {
    const table = fakeTable([]);
    const result = await readRequests(table);
    expect(result).toMatchObject({ status: "complete", rows: [], expectedCount: 0, pagesRead: 1 });
    expect(table.fetchPage).toHaveBeenCalledTimes(1);
    expect(table.fetchCount).toHaveBeenCalledTimes(2);
  });

  it("reads a single page and confirms it with a final empty page", async () => {
    const table = fakeTable([requestRow(1), requestRow(2)]);
    const result = await readRequests({ ...table, pageSize: 5 });
    expect(result).toMatchObject({ status: "complete", expectedCount: 2, pagesRead: 2 });
    expect(pageAfters(table.fetchPage)).toEqual([null, uuid(2)]);
  });

  it("reads multiple pages in ascending key order with an advancing cursor", async () => {
    const rows = [5, 3, 1, 4, 2].map((n) => requestRow(n));
    const table = fakeTable(rows);
    const result = await readRequests({ ...table, pageSize: 2 });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5].map(uuid));
    expect(pageAfters(table.fetchPage)).toEqual([null, uuid(2), uuid(4), uuid(5)]);
    expect(result.pagesRead).toBe(4);
  });

  it("does not stop on a short page caused by a server row cap below pageSize", async () => {
    const table = fakeTable(
      [1, 2, 3, 4, 5].map((n) => requestRow(n)),
      { cap: 2 },
    );
    const result = await readRequests({ ...table, pageSize: 10 });
    expect(result).toMatchObject({ status: "complete", expectedCount: 5, pagesRead: 4 });
    expect(pageAfters(table.fetchPage)).toEqual([null, uuid(2), uuid(4), uuid(5)]);
  });

  it("passes the configured pageSize as every page limit", async () => {
    const table = fakeTable([1, 2, 3].map((n) => requestRow(n)));
    await readRequests({ ...table, pageSize: 2 });
    expect(table.fetchPage.mock.calls.every(([request]) => request.limit === 2)).toBe(true);
  });

  it("uses the documented defaults when pageSize and maxPages are omitted", async () => {
    const table = fakeTable([requestRow(1)]);
    await readRequests(table);
    expect(table.fetchPage.mock.calls[0][0].limit).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(500);
    expect(DEFAULT_MAX_PAGES).toBe(1_000);
  });

  it("completes only when the counts before and after equal the rows collected", async () => {
    const table = fakeTable(
      [1, 2, 3].map((n) => requestRow(n)),
      { counts: [3, 3] },
    );
    const result = await readRequests({ ...table, pageSize: 2 });
    expect(result).toMatchObject({ status: "complete", expectedCount: 3 });
    expect(table.fetchCount).toHaveBeenCalledTimes(2);
  });

  it("keeps rows that contain null values unchanged", async () => {
    const rows = [requestRow(1, { created_at: null }), requestRow(2, { status: null })];
    const result = await readRequests(fakeTable(rows));
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.rows).toEqual(rows);
  });

  it("records the read window from the injected clock, not a snapshot instant", async () => {
    const times = [new Date("2026-11-19T10:00:00.000Z"), new Date("2026-11-19T10:00:02.500Z")];
    const result = await readRequests({ ...fakeTable([requestRow(1)]), now: () => times.shift()! });
    expect(result).toMatchObject({
      status: "complete",
      window: {
        readStartedAt: "2026-11-19T10:00:00.000Z",
        readCompletedAt: "2026-11-19T10:00:02.500Z",
      },
    });
  });

  it("supports a custom key field", async () => {
    const rows = [{ key: "b" }, { key: "a" }];
    const result = await readAllPages({
      fetchPage: async ({ after }) => ({
        data: [...rows]
          .sort((x, y) => (x.key < y.key ? -1 : 1))
          .filter((row) => after === null || row.key > after),
        error: null,
      }),
      fetchCount: fixedCount(2),
      requiredFields: ["key"],
      keyField: "key",
      signal: signal(),
    });
    expect(result).toMatchObject({ status: "complete", expectedCount: 2 });
  });
});

describe("readAllPages: options", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects pageSize %s", async (pageSize) => {
    await expect(readRequests({ ...fakeTable([]), pageSize })).rejects.toThrow(RangeError);
  });

  it.each([0, -1, 2.5])("rejects maxPages %s", async (maxPages) => {
    await expect(readRequests({ ...fakeTable([]), maxPages })).rejects.toThrow(RangeError);
  });

  it("rejects requiredFields that omit the key field", async () => {
    await expect(
      readRequests({ ...fakeTable([]), requiredFields: ["status", "created_at"] }),
    ).rejects.toThrow(/key field "id"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Pagination integrity failures
// ---------------------------------------------------------------------------

describe("readAllPages: integrity failures", () => {
  it.each([null, -1, 2.5, Number.NaN])(
    "is incomplete when the initial count is unusable (%s), before reading any page",
    async (count) => {
      const fetchPage = vi.fn<FetchPage>();
      const result = await readRequests({ fetchPage, fetchCount: fixedCount(count) });
      expect(result).toMatchObject({ status: "incomplete", reason: "count_unavailable" });
      expect(fetchPage).not.toHaveBeenCalled();
      expectNoRows(result);
    },
  );

  it("is incomplete when the final count is unavailable", async () => {
    const result = await readRequests(fakeTable([requestRow(1)], { counts: [1, null] }));
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "count_unavailable",
      counts: { expectedBefore: 1, expectedAfter: null, collected: 1 },
    });
    expectNoRows(result);
  });

  it.each([
    ["a row was inserted during paging", [3, 4], 3],
    ["a row was deleted during paging", [3, 2], 3],
    ["both counts disagree with the rows collected", [4, 4], 3],
  ])("is incomplete with count_mismatch when %s", async (_case, counts, rowCount) => {
    const rows = Array.from({ length: rowCount }, (_, i) => requestRow(i + 1));
    const result = await readRequests({ ...fakeTable(rows, { counts }), pageSize: 2 });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "count_mismatch",
      counts: { expectedBefore: counts[0], expectedAfter: counts[1], collected: rowCount },
    });
    expectNoRows(result);
  });

  it("fails on a page error after earlier pages succeeded, returning no rows", async () => {
    const table = fakeTable([1, 2, 3].map((n) => requestRow(n)));
    const error = { message: "upstream timeout" };
    const fetchPage = vi.fn<FetchPage>(async (request) =>
      request.after === null ? table.fetchPage(request) : { data: null, error },
    );
    const result = await readRequests({ ...table, fetchPage, pageSize: 2 });
    expect(result).toMatchObject({ status: "failed", error, pagesRead: 2 });
    expectNoRows(result);
  });

  it("fails on a count error, before or after paging", async () => {
    const error = { message: "count failed" };
    const failingFirst = await readRequests({
      fetchPage: vi.fn<FetchPage>(),
      fetchCount: async () => ({ count: null, error }),
    });
    expect(failingFirst).toMatchObject({ status: "failed", error, pagesRead: 0 });

    let call = 0;
    const failingLast = await readRequests({
      fetchPage: fakeTable([requestRow(1)]).fetchPage,
      fetchCount: async (): Promise<CountResponse> =>
        call++ === 0 ? { count: 1, error: null } : { count: null, error },
    });
    expect(failingLast).toMatchObject({ status: "failed", error });
    expectNoRows(failingLast);
  });

  it("fails when a fetcher throws instead of returning an error", async () => {
    const thrown = new TypeError("Failed to fetch");
    const pageThrows = await readRequests({
      fetchPage: async () => {
        throw thrown;
      },
      fetchCount: fixedCount(1),
    });
    expect(pageThrows).toMatchObject({ status: "failed", error: thrown, pagesRead: 1 });

    const countThrows = await readRequests({
      fetchPage: vi.fn<FetchPage>(),
      fetchCount: async () => {
        throw thrown;
      },
    });
    expect(countThrows).toMatchObject({ status: "failed", error: thrown, pagesRead: 0 });
    expectNoRows(pageThrows);
    expectNoRows(countThrows);
  });

  it("is incomplete when a page returns more rows than requested", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([{ data: [1, 2, 3].map((n) => requestRow(n)), error: null }]),
      fetchCount: fixedCount(3),
      pageSize: 2,
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "page_overflow" });
    expectNoRows(result);
  });

  it("is incomplete when a page has neither data nor an error", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([{ data: null, error: null }]),
      fetchCount: fixedCount(0),
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "missing_page_data" });
    expectNoRows(result);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an empty string", ""],
  ])("is incomplete with invalid_key when the key is %s", async (_case, key) => {
    const result = await readRequests({
      fetchPage: scriptedPages([{ data: [requestRow(1, { id: key })], error: null }]),
      fetchCount: fixedCount(1),
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "invalid_key" });
    expectNoRows(result);
  });

  it("is incomplete with duplicate_key for a repeat within one page", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([{ data: [requestRow(1), requestRow(1)], error: null }]),
      fetchCount: fixedCount(2),
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "duplicate_key" });
    expectNoRows(result);
  });

  it("is incomplete with duplicate_key for a repeat across pages", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([
        { data: [requestRow(1), requestRow(2)], error: null },
        { data: [requestRow(2), requestRow(3)], error: null },
      ]),
      fetchCount: fixedCount(3),
      pageSize: 2,
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "duplicate_key" });
    expectNoRows(result);
  });

  it("is incomplete with out_of_order for a descending key within a page", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([{ data: [requestRow(2), requestRow(1)], error: null }]),
      fetchCount: fixedCount(2),
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "out_of_order" });
    expectNoRows(result);
  });

  it("is incomplete with out_of_order when a page does not advance past the cursor", async () => {
    const result = await readRequests({
      fetchPage: scriptedPages([
        { data: [requestRow(3), requestRow(4)], error: null },
        { data: [requestRow(1)], error: null },
      ]),
      fetchCount: fixedCount(3),
      pageSize: 2,
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "out_of_order" });
    expectNoRows(result);
  });

  it("enforces maxPages, counting the final empty page", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => requestRow(n));
    // pageSize 2 needs pages of 2, 2, 1 and then the empty page: 4 calls.
    const tooFew = fakeTable(rows);
    const blocked = await readRequests({ ...tooFew, pageSize: 2, maxPages: 3 });
    expect(blocked).toMatchObject({ status: "incomplete", reason: "max_pages_exceeded" });
    expect(tooFew.fetchPage).toHaveBeenCalledTimes(3);
    expectNoRows(blocked);

    const enough = await readRequests({ ...fakeTable(rows), pageSize: 2, maxPages: 4 });
    expect(enough).toMatchObject({ status: "complete", pagesRead: 4 });
  });

  it("reports a missing required field with its absolute row index", async () => {
    const { created_at: _created, ...broken } = requestRow(3);
    const result = await readRequests({
      fetchPage: scriptedPages([
        { data: [requestRow(1), requestRow(2)], error: null },
        { data: [broken], error: null },
      ]),
      fetchCount: fixedCount(3),
      pageSize: 2,
    });
    expect(result).toMatchObject({
      status: "field_missing",
      missing: { rowIndex: 2, field: "created_at" },
      pagesRead: 2,
    });
    expectNoRows(result);
  });

  it("checks stage reads for workflow_revision", async () => {
    const { workflow_revision: _revision, ...stage } = stageRow(1, 1);
    const result = await readAllPages<EfficiencyStageRow>({
      fetchPage: scriptedPages([{ data: [stage], error: null }]),
      fetchCount: fixedCount(1),
      requiredFields: EFFICIENCY_STAGE_COLUMNS,
      signal: signal(),
    });
    expect(result).toMatchObject({
      status: "field_missing",
      missing: { field: "workflow_revision" },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Error classification
// ---------------------------------------------------------------------------

describe("readAllPages: error classification", () => {
  const failWith = (error: unknown) =>
    readRequests({
      fetchPage: vi.fn<FetchPage>(),
      fetchCount: async () => ({ count: null, error }),
    });

  it.each([
    ["Postgres permission denied", { code: "42501", message: "permission denied for table" }],
    ["PostgREST JWT error", { code: "PGRST301", message: "JWT invalid" }],
    ["HTTP 401", { status: 401, message: "Unauthorized" }],
    ["HTTP 403", { status: 403, message: "Forbidden" }],
    ["row-level security message", { message: "new row violates row-level security policy" }],
  ])("classifies %s as access", async (_case, error) => {
    const result = await failWith(error);
    expect(result).toMatchObject({ status: "failed", issue: { kind: "access" } });
    if (result.status === "failed") expect(result.issue).toEqual(classifyRequestReadError(error));
    expectNoRows(result);
  });

  it.each([
    ["HTTP 503", { status: 503, message: "Service Unavailable" }],
    [
      "missing table",
      { code: "42P01", message: 'relation "approval_stage_tracking" does not exist' },
    ],
    ["missing column", { code: "42703", message: "column workflow_revision does not exist" }],
    ["network failure", new TypeError("Failed to fetch")],
  ])("classifies %s as unavailable", async (_case, error) => {
    const result = await failWith(error);
    expect(result).toMatchObject({ status: "failed", issue: { kind: "unavailable" } });
    expectNoRows(result);
  });

  it("classifies a page error the same way and still returns no rows", async () => {
    const table = fakeTable([1, 2, 3].map((n) => requestRow(n)));
    const error = { code: "42501", message: "permission denied" };
    const result = await readRequests({
      ...table,
      fetchPage: async (request) =>
        request.after === null ? table.fetchPage(request) : { data: null, error },
      pageSize: 2,
    });
    expect(result).toMatchObject({ status: "failed", issue: { kind: "access" } });
    expectNoRows(result);
  });
});

// ---------------------------------------------------------------------------
// 5. Cancellation
// ---------------------------------------------------------------------------

describe("readAllPages: cancellation", () => {
  it("returns cancelled without any request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const table = fakeTable([requestRow(1)]);
    const result = await readRequests({ ...table, signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", pagesRead: 0 });
    expect(table.fetchCount).not.toHaveBeenCalled();
    expect(table.fetchPage).not.toHaveBeenCalled();
  });

  it("passes the signal to every fetcher", async () => {
    const controller = new AbortController();
    const table = fakeTable([1, 2].map((n) => requestRow(n)));
    await readRequests({ ...table, signal: controller.signal, pageSize: 1 });
    for (const [request] of table.fetchPage.mock.calls)
      expect(request.signal).toBe(controller.signal);
    for (const [request] of table.fetchCount.mock.calls)
      expect(request.signal).toBe(controller.signal);
  });

  it("returns cancelled when aborted during the initial count, without reading pages", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn<FetchPage>();
    const result = await readRequests({
      fetchPage,
      fetchCount: async () => {
        controller.abort();
        return { count: 1, error: null };
      },
      signal: controller.signal,
    });
    expect(result).toEqual({ status: "cancelled", pagesRead: 0 });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns cancelled, not failed, when an aborted count request errors or throws", async () => {
    const outcomes: FetchCount[] = [
      async () => ({ count: null, error: { name: "AbortError" } }),
      async () => {
        throw new DOMException("aborted", "AbortError");
      },
    ];
    for (const fetchCount of outcomes) {
      const controller = new AbortController();
      const result = await readRequests({
        fetchPage: vi.fn<FetchPage>(),
        fetchCount: async (request) => {
          controller.abort();
          return fetchCount(request);
        },
        signal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
    }
  });

  it("returns cancelled when aborted during a page request, discarding rows already read", async () => {
    const controller = new AbortController();
    const table = fakeTable([1, 2, 3].map((n) => requestRow(n)));
    const result = await readRequests({
      ...table,
      fetchPage: async (request) => {
        if (request.after !== null) controller.abort();
        return table.fetchPage(request);
      },
      signal: controller.signal,
      pageSize: 2,
    });
    expect(result).toEqual({ status: "cancelled", pagesRead: 2 });
    expectNoRows(result);
  });

  it("returns cancelled, not failed, when an aborted page request errors or throws", async () => {
    for (const outcome of ["error", "throw"] as const) {
      const controller = new AbortController();
      const result = await readRequests({
        fetchPage: async () => {
          controller.abort();
          if (outcome === "throw") throw new DOMException("aborted", "AbortError");
          return { data: null, error: { name: "AbortError" } };
        },
        fetchCount: fixedCount(1),
        signal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
    }
  });

  it("requests no further page after an abort that lands between pages", async () => {
    const controller = new AbortController();
    const table = fakeTable([1, 2, 3].map((n) => requestRow(n)));
    const fetchPage = vi.fn<FetchPage>(async (request) => {
      const page = await table.fetchPage(request);
      controller.abort(); // the first page's response arrives after the abort
      return page;
    });
    const result = await readRequests({
      ...table,
      fetchPage,
      signal: controller.signal,
      pageSize: 2,
    });
    expect(result).toEqual({ status: "cancelled", pagesRead: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns cancelled when aborted during the final count", async () => {
    const controller = new AbortController();
    let call = 0;
    const result = await readRequests({
      fetchPage: fakeTable([requestRow(1)]).fetchPage,
      fetchCount: async () => {
        if (call++ === 1) controller.abort();
        return { count: 1, error: null };
      },
      signal: controller.signal,
    });
    expect(result).toEqual({ status: "cancelled", pagesRead: 2 });
    expectNoRows(result);
  });
});

// ---------------------------------------------------------------------------
// 6. Dataset integrity
// ---------------------------------------------------------------------------

const asRequests = (rows: readonly Record<string, unknown>[]) =>
  rows as unknown as readonly EfficiencyRequestRow[];
const asStages = (rows: readonly Record<string, unknown>[]) =>
  rows as unknown as readonly EfficiencyStageRow[];

const complete = <Row>(rows: readonly Row[]): TableReadResult<Row> => ({
  status: "complete",
  rows,
  expectedCount: rows.length,
  pagesRead: 2,
  window: WINDOW,
});
const failed = <Row>(error: unknown): TableReadResult<Row> => ({
  status: "failed",
  error,
  issue: classifyRequestReadError(error),
  pagesRead: 1,
});
const incomplete = <Row>(): TableReadResult<Row> => ({
  status: "incomplete",
  reason: "count_mismatch",
  counts: { expectedBefore: 3, expectedAfter: 4, collected: 3 },
  pagesRead: 3,
});
const fieldMissing = <Row>(): TableReadResult<Row> => ({
  status: "field_missing",
  missing: { rowIndex: 0, field: "created_at" },
  pagesRead: 1,
});
const cancelledRead = <Row>(): TableReadResult<Row> => ({ status: "cancelled", pagesRead: 1 });

const REQUESTS = asRequests([requestRow(1), requestRow(2)]);
const STAGES = asStages([
  stageRow(1, 1, { status: "completed", completed_at: "2026-11-03T12:00:00.000000+00:00" }),
  stageRow(2, 1, { stage_order: 2, status: "active" }),
  stageRow(3, 2),
]);
const ACCESS_ERROR = { code: "42501", message: "permission denied" };
const OUTAGE_ERROR = { status: 503, message: "Service Unavailable" };

describe("checkDatasetIntegrity", () => {
  it("returns a per-table-validated dataset, not a snapshot, when both reads are complete", () => {
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(STAGES),
    });
    expect(result).toEqual({
      status: "complete",
      dataset: {
        requests: REQUESTS,
        stages: STAGES,
        consistency: "per-table-validated",
        reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
      },
    });
  });

  it("accepts complete empty tables", () => {
    expect(
      checkDatasetIntegrity({ requests: complete(asRequests([])), stages: complete(asStages([])) }),
    ).toMatchObject({ status: "complete", dataset: { requests: [], stages: [] } });
  });

  it("blocks on a failed request read but keeps the complete stage table", () => {
    const result = checkDatasetIntegrity({
      requests: failed(ACCESS_ERROR),
      stages: complete(STAGES),
    });
    expect(result).toEqual({
      status: "blocked",
      errors: ["request_read_failed"],
      issue: classifyRequestReadError(ACCESS_ERROR),
      completeTables: {
        financial_requests: null,
        approval_stage_tracking: { rows: STAGES, window: WINDOW },
      },
    });
  });

  it("blocks on a failed stage read but keeps the complete request table", () => {
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: failed(OUTAGE_ERROR),
    });
    expect(result).toEqual({
      status: "blocked",
      errors: ["stage_read_failed"],
      issue: classifyRequestReadError(OUTAGE_ERROR),
      completeTables: {
        financial_requests: { rows: REQUESTS, window: WINDOW },
        approval_stage_tracking: null,
      },
    });
  });

  it.each([
    ["requests", "incomplete", "request_read_incomplete"],
    ["requests", "field_missing", "request_field_missing"],
    ["stages", "incomplete", "stage_read_incomplete"],
    ["stages", "field_missing", "stage_field_missing"],
  ] as const)("maps an %s read that is %s to %s, with no issue", (table, outcome, code) => {
    const bad = outcome === "incomplete" ? incomplete() : fieldMissing();
    const result = checkDatasetIntegrity({
      requests:
        table === "requests" ? (bad as TableReadResult<EfficiencyRequestRow>) : complete(REQUESTS),
      stages: table === "stages" ? (bad as TableReadResult<EfficiencyStageRow>) : complete(STAGES),
    });
    expect(result).toMatchObject({ status: "blocked", errors: [code], issue: null });
    if (result.status !== "blocked") return;
    const tables = result.completeTables;
    expect(tables.financial_requests).toEqual(
      table === "requests" ? null : { rows: REQUESTS, window: WINDOW },
    );
    expect(tables.approval_stage_tracking).toEqual(
      table === "stages" ? null : { rows: STAGES, window: WINDOW },
    );
  });

  it("re-checks required columns on a complete read and drops that table", () => {
    const { workflow_revision: _revision, ...noRevision } = stageRow(9, 1);
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(asStages([...STAGES, noRevision])),
    });
    expect(result).toMatchObject({
      status: "blocked",
      errors: ["stage_field_missing"],
      completeTables: { approval_stage_tracking: null },
    });
  });

  it.each([
    ["requests", "a complete stage read"],
    ["stages", "a complete request read"],
    ["both", "another cancelled read"],
  ])("returns cancelled when %s are cancelled, alongside %s", (table) => {
    const result = checkDatasetIntegrity({
      requests: table !== "stages" ? cancelledRead() : complete(REQUESTS),
      stages: table !== "requests" ? cancelledRead() : complete(STAGES),
    });
    expect(result).toEqual({ status: "cancelled" });
  });

  it("returns cancelled even when the other read failed", () => {
    expect(
      checkDatasetIntegrity({ requests: failed(ACCESS_ERROR), stages: cancelledRead() }),
    ).toEqual({ status: "cancelled" });
  });

  it("flags a stage whose request was not loaded, keeping both complete tables", () => {
    const orphan = stageRow(4, 99);
    const stages = asStages([...STAGES, orphan]);
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(stages),
    });
    expect(result).toEqual({
      status: "blocked",
      errors: ["stage_request_not_loaded"],
      issue: null,
      completeTables: {
        financial_requests: { rows: REQUESTS, window: WINDOW },
        approval_stage_tracking: { rows: stages, window: WINDOW },
      },
    });
  });

  it("loads every workflow revision, so cancelled earlier-revision stages are not orphans", () => {
    const amended = asStages([
      stageRow(1, 1, { status: "completed", completed_at: "2026-11-04T09:00:00Z" }),
      stageRow(2, 1, { stage_order: 2, status: "cancelled", completed_at: "2026-11-05T09:00:00Z" }),
      stageRow(3, 1, { workflow_revision: 2, stage_order: 1, status: "active" }),
    ]);
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(amended),
    });
    expect(result).toMatchObject({ status: "complete", dataset: { stages: amended } });
  });

  it("skips the orphan check when either table is unusable", () => {
    const orphanStages = asStages([stageRow(4, 99)]);
    for (const requests of [
      failed<EfficiencyRequestRow>(ACCESS_ERROR),
      incomplete<EfficiencyRequestRow>(),
    ]) {
      const result = checkDatasetIntegrity({ requests, stages: complete(orphanStages) });
      expect(result.status).toBe("blocked");
      if (result.status === "blocked")
        expect(result.errors).not.toContain("stage_request_not_loaded");
    }
    const { request_id: _requestId, ...noRequestId } = stageRow(4, 99);
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(asStages([noRequestId])),
    });
    expect(result).toMatchObject({ status: "blocked", errors: ["stage_field_missing"] });
  });

  it("returns every error once, in LOAD_INTEGRITY_ERROR_CODES order", () => {
    const result = checkDatasetIntegrity({
      requests: incomplete(),
      stages: failed(OUTAGE_ERROR),
    });
    expect(result).toMatchObject({
      status: "blocked",
      errors: ["request_read_incomplete", "stage_read_failed"],
      issue: classifyRequestReadError(OUTAGE_ERROR),
      completeTables: { financial_requests: null, approval_stage_tracking: null },
    });
    if (result.status !== "blocked") return;
    const order = result.errors.map((code) => LOAD_INTEGRITY_ERROR_CODES.indexOf(code));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(result.errors).size).toBe(result.errors.length);
  });

  it("takes the issue from the request read when both reads failed", () => {
    const result = checkDatasetIntegrity({
      requests: failed(ACCESS_ERROR),
      stages: failed(OUTAGE_ERROR),
    });
    expect(result).toMatchObject({
      status: "blocked",
      errors: ["request_read_failed", "stage_read_failed"],
      issue: { kind: "access" },
    });
  });

  it("never returns rows from an unsuccessful read", () => {
    for (const bad of [failed(ACCESS_ERROR), incomplete(), fieldMissing()]) {
      const result = checkDatasetIntegrity({
        requests: bad as TableReadResult<EfficiencyRequestRow>,
        stages: complete(STAGES),
      });
      expect(result).toMatchObject({
        status: "blocked",
        completeTables: { financial_requests: null },
      });
      expect(result).not.toHaveProperty("dataset");
    }
  });

  it("introduces no prototype rows and does not alter the loaded rows", () => {
    const result = checkDatasetIntegrity({
      requests: complete(REQUESTS),
      stages: complete(STAGES),
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.dataset.requests).toBe(REQUESTS);
    expect(result.dataset.stages).toBe(STAGES);
    for (const row of [...result.dataset.requests, ...result.dataset.stages]) {
      expect(row).not.toHaveProperty("prototype");
    }
  });
});

// ---------------------------------------------------------------------------
// End to end through the public API with injected fetchers
// ---------------------------------------------------------------------------

describe("readAllPages + checkDatasetIntegrity", () => {
  it("builds a complete dataset from two paginated reads", async () => {
    const requests = await readRequests({
      ...fakeTable([1, 2, 3].map((n) => requestRow(n))),
      pageSize: 2,
    });
    const stages = await readAllPages<EfficiencyStageRow>({
      ...fakeTable([stageRow(1, 1), stageRow(2, 3)], { cap: 1 }),
      requiredFields: EFFICIENCY_STAGE_COLUMNS,
      pageSize: 5,
      signal: signal(),
    });
    const result = checkDatasetIntegrity({ requests, stages });
    expect(result).toMatchObject({
      status: "complete",
      dataset: { consistency: "per-table-validated" },
    });
    if (result.status === "complete") {
      expect(result.dataset.requests).toHaveLength(3);
      expect(result.dataset.stages).toHaveLength(2);
    }
  });

  it("blocks a request created between the two reads as stage_request_not_loaded", async () => {
    const requests = await readRequests(fakeTable([requestRow(1)]));
    // Request 2 and its stage appear after the request read finished.
    const stages = await readAllPages<EfficiencyStageRow>({
      ...fakeTable([stageRow(1, 1), stageRow(2, 2)]),
      requiredFields: EFFICIENCY_STAGE_COLUMNS,
      signal: signal(),
    });
    const result = checkDatasetIntegrity({ requests, stages });
    expect(result).toMatchObject({ status: "blocked", errors: ["stage_request_not_loaded"] });
  });
});
