/**
 * F19.3: pure, browser-safe data validation and pagination for efficiency
 * analytics. No I/O of its own: callers inject the page and count fetchers.
 *
 * - readAllPages reads one table with keyset pagination by `id` and validates
 *   pagination completeness and per-table counts.
 * - checkRequiredFields reports a field absent from a row (a null value is
 *   present and is left to F19.4's data-quality rules).
 * - checkDatasetIntegrity combines a request read and a stage read into a
 *   complete dataset or the F19.1 load-integrity error codes.
 *
 * What this module does NOT guarantee (KNOWN_LIMITATIONS.non_atomic_reads):
 * pages and tables are read by separate requests, so a complete result is not
 * a consistent database snapshot. Matching counts do not show that rows stayed
 * unchanged; offsetting inserts and deletes, rows that change after they were
 * read, and changes between the two table reads cannot be detected.
 *
 * Imports are type-only except the catalog constants and the shared
 * request-read error classifier, both of which are pure.
 */
import type { Database } from "@/integrations/supabase/types";
import type { ApprovalStageRow } from "@/lib/approval-stage-client";
import {
  LOAD_INTEGRITY_ERROR_CODES,
  SOURCE_FIELDS,
  type LoadIntegrityErrorCode,
  type SourceTable,
} from "@/lib/efficiency-metrics";
import { classifyRequestReadError, type RequestReadIssue } from "@/lib/request-list";

// ---------------------------------------------------------------------------
// Columns and row types
// ---------------------------------------------------------------------------

/**
 * Keyset pagination key for both tables. For approval_stage_tracking it is not
 * a metric source (SOURCE_FIELDS excludes it); it is selected only to page.
 */
export const PAGINATION_KEY = "id" as const;

/** Columns a request read must return: exactly the request source fields (id is one of them). */
export const EFFICIENCY_REQUEST_COLUMNS = Object.freeze([
  ...SOURCE_FIELDS.financial_requests,
] as const);

/** Columns a stage read must return: the pagination key plus the stage source fields. */
export const EFFICIENCY_STAGE_COLUMNS = Object.freeze([
  PAGINATION_KEY,
  ...SOURCE_FIELDS.approval_stage_tracking,
] as const);

export type EfficiencyRequestColumn = (typeof EFFICIENCY_REQUEST_COLUMNS)[number];
export type EfficiencyStageColumn = (typeof EFFICIENCY_STAGE_COLUMNS)[number];

/**
 * A request row as loaded for analytics. Picked from the generated row type,
 * so a SOURCE_FIELDS entry with no matching column fails type checking. No
 * person-level columns (user_id, requester_email) are included.
 */
export type EfficiencyRequestRow = Pick<
  Database["public"]["Tables"]["financial_requests"]["Row"],
  EfficiencyRequestColumn
>;

/**
 * A stage row as loaded for analytics, including workflow_revision and the
 * `id` pagination key. Picked from the shared ApprovalStageRow view.
 */
export type EfficiencyStageRow = Pick<ApprovalStageRow, EfficiencyStageColumn>;

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

/** The first row/field pair that is absent, or null when every row has every field. */
export type MissingField = { readonly rowIndex: number; readonly field: string };

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Returns the first row that lacks a required field as an own property, or
 * null. A field whose value is null is present. A row that is not a plain
 * object lacks every field.
 */
export function findMissingField(
  rows: readonly unknown[],
  fields: readonly string[],
): MissingField | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (const field of fields) {
      if (row === null || typeof row !== "object" || !hasOwn(row, field)) {
        return { rowIndex, field };
      }
    }
  }
  return null;
}

const FIELD_MISSING_CODE: Record<SourceTable, LoadIntegrityErrorCode> = {
  financial_requests: "request_field_missing",
  approval_stage_tracking: "stage_field_missing",
};

const TABLE_COLUMNS: Record<SourceTable, readonly string[]> = {
  financial_requests: EFFICIENCY_REQUEST_COLUMNS,
  approval_stage_tracking: EFFICIENCY_STAGE_COLUMNS,
};

/** request_field_missing / stage_field_missing when any row lacks a required column; otherwise null. */
export function checkRequiredFields(
  table: SourceTable,
  rows: readonly unknown[],
): LoadIntegrityErrorCode | null {
  return findMissingField(rows, TABLE_COLUMNS[table]) ? FIELD_MISSING_CODE[table] : null;
}

// ---------------------------------------------------------------------------
// Paginated reader
// ---------------------------------------------------------------------------

/** Shape of one page response; mirrors Supabase's { data, error }. */
export type PageResponse = { readonly data: readonly unknown[] | null; readonly error: unknown };

/** Shape of one exact-count response; mirrors Supabase's { count, error }. */
export type CountResponse = { readonly count: number | null; readonly error: unknown };

export type FetchPage = (request: {
  /** Return rows whose key is strictly greater than this; null for the first page. */
  readonly after: string | null;
  /** Maximum rows to return, ordered by the key ascending. */
  readonly limit: number;
  readonly signal: AbortSignal;
}) => Promise<PageResponse>;

export type FetchCount = (request: { readonly signal: AbortSignal }) => Promise<CountResponse>;

export type ReadAllPagesOptions = {
  readonly fetchPage: FetchPage;
  readonly fetchCount: FetchCount;
  /** Every column each row must carry. Must include keyField. */
  readonly requiredFields: readonly string[];
  readonly keyField?: string;
  /** Rows requested per page. Defaults to DEFAULT_PAGE_SIZE. */
  readonly pageSize?: number;
  /** Maximum fetchPage calls, including the final empty page. Defaults to DEFAULT_MAX_PAGES. */
  readonly maxPages?: number;
  readonly signal: AbortSignal;
  /** Clock for the read window; injectable for tests. */
  readonly now?: () => Date;
};

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_MAX_PAGES = 1_000;

/** Why a read that returned no error still cannot be trusted as complete. */
export type IncompleteReason =
  /** fetchCount returned no usable count, so completeness cannot be checked. */
  | "count_unavailable"
  /** The counts before and after paging and the rows collected are not all equal. */
  | "count_mismatch"
  /** A page returned more rows than requested. */
  | "page_overflow"
  /** A row's key is not a non-empty string. */
  | "invalid_key"
  /** The same key appeared twice, within a page or across pages. */
  | "duplicate_key"
  /** A key is not strictly greater than the one before it (including the cursor). */
  | "out_of_order"
  /** The page limit was reached before an empty page ended the read. */
  | "max_pages_exceeded"
  /** A page response had neither data nor an error. */
  | "missing_page_data";

/** The interval during which a table was read. Not a snapshot instant. */
export type ReadWindow = { readonly readStartedAt: string; readonly readCompletedAt: string };

export type CountCheck = {
  readonly expectedBefore: number | null;
  readonly expectedAfter: number | null;
  readonly collected: number;
};

export type TableReadResult<Row> =
  | {
      readonly status: "complete";
      readonly rows: readonly Row[];
      /** Equal before and after paging, and equal to rows.length. */
      readonly expectedCount: number;
      /** fetchPage calls made, including the final empty page. */
      readonly pagesRead: number;
      readonly window: ReadWindow;
    }
  | {
      /** A page or count request returned an error or threw. No rows are returned. */
      readonly status: "failed";
      readonly error: unknown;
      /** Access (permission) vs. unavailable, per the shared request-read convention. */
      readonly issue: RequestReadIssue;
      readonly pagesRead: number;
    }
  | {
      /** Every request succeeded but completeness could not be shown. No rows are returned. */
      readonly status: "incomplete";
      readonly reason: IncompleteReason;
      readonly counts: CountCheck;
      readonly pagesRead: number;
    }
  | {
      /** A returned row lacks a required column. No rows are returned. */
      readonly status: "field_missing";
      readonly missing: MissingField;
      readonly pagesRead: number;
    }
  | {
      /** The signal was aborted. No rows are returned. */
      readonly status: "cancelled";
      readonly pagesRead: number;
    };

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Reads every row of one table that the caller may see, using keyset
 * pagination ordered by the key ascending (`key > after`, `limit pageSize`).
 *
 * Sequence: exact count (before) → pages until an empty page → exact count
 * (after). A short page does not end the read, so a server row cap below
 * pageSize cannot silently truncate it.
 *
 * Complete only when every request succeeded, every row has every required
 * field, keys are non-empty strings, unique and strictly increasing across
 * all pages, no page exceeds pageSize, the empty page arrived within
 * maxPages, and countBefore === countAfter === rows collected.
 *
 * Keys are compared as strings. Postgres orders uuid values byte by byte,
 * which matches the ordering of their lowercase hex text, as PostgREST
 * returns them.
 *
 * Any non-complete outcome returns no rows. The result validates this table's
 * read only; it is not a consistent database snapshot (non_atomic_reads).
 *
 * Throws RangeError only for invalid options (a programming error).
 */
export async function readAllPages<Row>(
  options: ReadAllPagesOptions,
): Promise<TableReadResult<Row>> {
  const keyField = options.keyField ?? PAGINATION_KEY;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? (() => new Date());
  const { fetchPage, fetchCount, requiredFields, signal } = options;

  if (!isPositiveInteger(pageSize)) throw new RangeError("pageSize must be a positive integer.");
  if (!isPositiveInteger(maxPages)) throw new RangeError("maxPages must be a positive integer.");
  if (!requiredFields.includes(keyField)) {
    throw new RangeError(`requiredFields must include the key field "${keyField}".`);
  }

  let pagesRead = 0;
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let expectedBefore: number | null = null;
  let expectedAfter: number | null = null;

  const counts = (): CountCheck => ({ expectedBefore, expectedAfter, collected: rows.length });
  const cancelled = (): TableReadResult<Row> => ({ status: "cancelled", pagesRead });
  const incomplete = (reason: IncompleteReason): TableReadResult<Row> => ({
    status: "incomplete",
    reason,
    counts: counts(),
    pagesRead,
  });
  const failed = (error: unknown): TableReadResult<Row> =>
    signal.aborted
      ? cancelled()
      : { status: "failed", error, issue: classifyRequestReadError(error), pagesRead };

  const readCount = async (): Promise<number | TableReadResult<Row>> => {
    let response: CountResponse;
    try {
      response = await fetchCount({ signal });
    } catch (error) {
      return failed(error);
    }
    if (signal.aborted) return cancelled();
    if (response.error) return failed(response.error);
    return isCount(response.count) ? response.count : incomplete("count_unavailable");
  };

  if (signal.aborted) return cancelled();
  const readStartedAt = now().toISOString();

  const before = await readCount();
  if (typeof before !== "number") return before;
  expectedBefore = before;

  for (;;) {
    if (signal.aborted) return cancelled();
    if (pagesRead >= maxPages) return incomplete("max_pages_exceeded");

    let response: PageResponse;
    try {
      response = await fetchPage({ after: cursor, limit: pageSize, signal });
    } catch (error) {
      pagesRead += 1;
      return failed(error);
    }
    pagesRead += 1;
    if (signal.aborted) return cancelled();
    if (response.error) return failed(response.error);
    if (!response.data) return incomplete("missing_page_data");

    const page = response.data;
    if (page.length === 0) break;
    if (page.length > pageSize) return incomplete("page_overflow");

    const missing = findMissingField(page, requiredFields);
    if (missing) {
      return {
        status: "field_missing",
        missing: { rowIndex: rows.length + missing.rowIndex, field: missing.field },
        pagesRead,
      };
    }

    for (const row of page) {
      const key = (row as Record<string, unknown>)[keyField];
      if (typeof key !== "string" || key.length === 0) return incomplete("invalid_key");
      if (seen.has(key)) return incomplete("duplicate_key");
      if (cursor !== null && key <= cursor) return incomplete("out_of_order");
      seen.add(key);
      rows.push(row);
      cursor = key;
    }
  }

  const after = await readCount();
  if (typeof after !== "number") return after;
  expectedAfter = after;

  if (expectedBefore !== expectedAfter || expectedAfter !== rows.length) {
    return incomplete("count_mismatch");
  }

  return {
    status: "complete",
    rows: rows as Row[],
    expectedCount: rows.length,
    pagesRead,
    window: { readStartedAt, readCompletedAt: now().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Dataset integrity
// ---------------------------------------------------------------------------

/**
 * A request dataset and stage dataset that passed every load-integrity check.
 * `consistency` is deliberately not "snapshot": each table's read was
 * validated on its own, and the two were read at different times.
 */
export type EfficiencyDataset = {
  readonly requests: readonly EfficiencyRequestRow[];
  readonly stages: readonly EfficiencyStageRow[];
  readonly consistency: "per-table-validated";
  readonly reads: {
    readonly financial_requests: ReadWindow;
    readonly approval_stage_tracking: ReadWindow;
  };
};

/** One table whose own read was complete and had every required column. */
export type CompleteTable<Row> = { readonly rows: readonly Row[]; readonly window: ReadWindow };

export type DatasetIntegrityResult =
  | { readonly status: "complete"; readonly dataset: EfficiencyDataset }
  | {
      readonly status: "blocked";
      /** Distinct codes, in LOAD_INTEGRITY_ERROR_CODES order. Never empty. */
      readonly errors: readonly LoadIntegrityErrorCode[];
      /** Classification of the first failed read (requests first), or null when none failed. */
      readonly issue: RequestReadIssue | null;
      /**
       * Tables whose own read was complete with every required column. F19.1
       * blocks a metric only on the codes in its loadIntegrityErrors, so for
       * example Request Volume can still use a complete request read when the
       * stage read failed (section 5.7). Rows from a failed, incomplete,
       * field-missing or cancelled read are never included.
       */
      readonly completeTables: {
        readonly financial_requests: CompleteTable<EfficiencyRequestRow> | null;
        readonly approval_stage_tracking: CompleteTable<EfficiencyStageRow> | null;
      };
    }
  | { readonly status: "cancelled" };

const READ_ERROR_CODES: Record<
  SourceTable,
  Record<"failed" | "incomplete" | "field_missing", LoadIntegrityErrorCode>
> = {
  financial_requests: {
    failed: "request_read_failed",
    incomplete: "request_read_incomplete",
    field_missing: "request_field_missing",
  },
  approval_stage_tracking: {
    failed: "stage_read_failed",
    incomplete: "stage_read_incomplete",
    field_missing: "stage_field_missing",
  },
};

/**
 * Combines the two table reads into one dataset or load-integrity errors.
 *
 * - Either read cancelled → cancelled.
 * - Each non-complete read maps to its table's failed / incomplete /
 *   field_missing code.
 * - Each complete read is re-checked for every required column
 *   (EFFICIENCY_REQUEST_COLUMNS / EFFICIENCY_STAGE_COLUMNS).
 * - When both reads are otherwise usable, any stage whose request_id is not
 *   among the loaded request ids → stage_request_not_loaded.
 *
 * Only a result with no errors is a complete dataset. A blocked result lists
 * every code and keeps only tables whose own read was complete, so callers
 * can still apply each metric's loadIntegrityErrors. Prototype rows are not
 * handled here; the analytics layer merges them separately.
 */
export function checkDatasetIntegrity(input: {
  readonly requests: TableReadResult<EfficiencyRequestRow>;
  readonly stages: TableReadResult<EfficiencyStageRow>;
}): DatasetIntegrityResult {
  const { requests, stages } = input;
  if (requests.status === "cancelled" || stages.status === "cancelled") {
    return { status: "cancelled" };
  }

  const errors = new Set<LoadIntegrityErrorCode>();
  const usable = <Row>(
    table: SourceTable,
    read: TableReadResult<Row>,
  ): CompleteTable<Row> | null => {
    if (read.status !== "complete") {
      if (read.status !== "cancelled") errors.add(READ_ERROR_CODES[table][read.status]);
      return null;
    }
    const missing = checkRequiredFields(table, read.rows);
    if (missing) {
      errors.add(missing);
      return null;
    }
    return { rows: read.rows, window: read.window };
  };

  const requestTable = usable("financial_requests", requests);
  const stageTable = usable("approval_stage_tracking", stages);

  if (requestTable && stageTable) {
    const requestIds = new Set(requestTable.rows.map((row) => row.id));
    if (stageTable.rows.some((stage) => !requestIds.has(stage.request_id))) {
      errors.add("stage_request_not_loaded");
    }
  }

  if (errors.size > 0 || !requestTable || !stageTable) {
    const firstFailure = [requests, stages].find((read) => read.status === "failed");
    return {
      status: "blocked",
      errors: LOAD_INTEGRITY_ERROR_CODES.filter((code) => errors.has(code)),
      issue: firstFailure?.status === "failed" ? firstFailure.issue : null,
      completeTables: {
        financial_requests: requestTable,
        approval_stage_tracking: stageTable,
      },
    };
  }

  return {
    status: "complete",
    dataset: {
      requests: requestTable.rows,
      stages: stageTable.rows,
      consistency: "per-table-validated",
      reads: {
        financial_requests: requestTable.window,
        approval_stage_tracking: stageTable.window,
      },
    },
  };
}
