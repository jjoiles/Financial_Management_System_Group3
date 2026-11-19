/**
 * F19.3: Supabase-bound loader for efficiency analytics.
 *
 * Reads financial_requests, then approval_stage_tracking, through the existing
 * shared browser client (stages through its typed approvalStageClient view),
 * with keyset pagination by `id` and exact counts before and after paging,
 * and combines them with checkDatasetIntegrity.
 *
 * - Reads only. No writes, no new client or session, no Realtime.
 * - RLS decides which rows are visible; the loader adds no user filter, so
 *   requesters see their own rows and admin, reviewer and leadership users
 *   see every row (role_scoped_visibility).
 * - Selects exactly EFFICIENCY_REQUEST_COLUMNS / EFFICIENCY_STAGE_COLUMNS:
 *   no person-level or actor columns. Stage status is not filtered, so every
 *   status and every workflow revision is loaded.
 * - No aggregation, prototype merging or UI shaping.
 * - A complete result is "per-table-validated", not a database snapshot
 *   (KNOWN_LIMITATIONS.non_atomic_reads).
 */
import { supabase } from "@/integrations/supabase/client";
import { approvalStageClient } from "@/lib/approval-stage-client";
import {
  DEFAULT_PAGE_SIZE,
  EFFICIENCY_REQUEST_COLUMNS,
  EFFICIENCY_STAGE_COLUMNS,
  PAGINATION_KEY,
  checkDatasetIntegrity,
  readAllPages,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type FetchCount,
  type FetchPage,
  type IncompleteReason,
  type TableReadResult,
} from "@/lib/efficiency-data";
import type { LoadIntegrityErrorCode } from "@/lib/efficiency-metrics";

export const DEFAULT_MAX_ATTEMPTS = 2;

/** PostgREST select lists, derived from the shared column constants. */
export const EFFICIENCY_REQUEST_SELECT = EFFICIENCY_REQUEST_COLUMNS.join(",");
export const EFFICIENCY_STAGE_SELECT = EFFICIENCY_STAGE_COLUMNS.join(",");

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * financial_requests through the shared client. Page: select the request
 * columns, `id > after` (after the first page), order by id ascending,
 * limit. Count: exact, head-only (no rows transferred).
 */
const requestFetchers: { readonly fetchPage: FetchPage; readonly fetchCount: FetchCount } = {
  fetchPage: async ({ after, limit, signal }) => {
    let query = supabase.from("financial_requests").select(EFFICIENCY_REQUEST_SELECT);
    if (after !== null) query = query.gt(PAGINATION_KEY, after);
    const { data, error } = await query
      .order(PAGINATION_KEY, { ascending: true })
      .limit(limit)
      .abortSignal(signal);
    return { data: data as unknown as readonly unknown[] | null, error };
  },
  fetchCount: async ({ signal }) => {
    const { count, error } = await supabase
      .from("financial_requests")
      .select(PAGINATION_KEY, { count: "exact", head: true })
      .abortSignal(signal);
    return { count, error };
  },
};

/**
 * approval_stage_tracking through approvalStageClient (the same session).
 * Same shape as requests, with no status filter.
 */
const stageFetchers: { readonly fetchPage: FetchPage; readonly fetchCount: FetchCount } = {
  fetchPage: async ({ after, limit, signal }) => {
    let query = approvalStageClient.from("approval_stage_tracking").select(EFFICIENCY_STAGE_SELECT);
    if (after !== null) query = query.gt(PAGINATION_KEY, after);
    const { data, error } = await query
      .order(PAGINATION_KEY, { ascending: true })
      .limit(limit)
      .abortSignal(signal);
    return { data: data as unknown as readonly unknown[] | null, error };
  },
  fetchCount: async ({ signal }) => {
    const { count, error } = await approvalStageClient
      .from("approval_stage_tracking")
      .select(PAGINATION_KEY, { count: "exact", head: true })
      .abortSignal(signal);
    return { count, error };
  },
};

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Incomplete reasons a concurrent write can cause. Keys are immutable primary
 * keys read in keyset order, so a write during paging shows up only as a
 * count mismatch. Every other reason (count_unavailable, page_overflow,
 * invalid_key, duplicate_key, out_of_order, max_pages_exceeded,
 * missing_page_data) points at the server or configuration, and an immediate
 * retry would not fix it.
 */
export const RACE_INCOMPLETE_REASONS: ReadonlySet<IncompleteReason> = new Set(["count_mismatch"]);

const isRaceIncomplete = (read: TableReadResult<unknown> | null) =>
  read?.status === "incomplete" && RACE_INCOMPLETE_REASONS.has(read.reason);

/**
 * True only when the load was blocked and every error is race-related:
 * stage_request_not_loaded (a request created between the two reads), or a
 * *_read_incomplete whose table read ended in a count mismatch. Any other
 * error (failed reads, including access and availability errors, missing
 * fields, non-race incomplete reasons) makes the load non-retryable, because
 * retrying would not change it.
 */
export function isRetryableLoad(attempt: {
  readonly requests: TableReadResult<EfficiencyRequestRow>;
  readonly stages: TableReadResult<EfficiencyStageRow>;
  readonly integrity: DatasetIntegrityResult;
}): boolean {
  const { requests, stages, integrity } = attempt;
  if (integrity.status !== "blocked") return false;
  const retryable = (code: LoadIntegrityErrorCode) =>
    code === "stage_request_not_loaded" ||
    (code === "request_read_incomplete" && isRaceIncomplete(requests)) ||
    (code === "stage_read_incomplete" && isRaceIncomplete(stages));
  return integrity.errors.length > 0 && integrity.errors.every(retryable);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadEfficiencyDatasetOptions = {
  /**
   * The signed-in user this load is for, from the existing auth context. It
   * is not sent to the database (RLS uses the session) and is returned so the
   * caller can discard a result whose user is no longer signed in.
   */
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly pageSize?: number;
  /** Total attempts, including the first. Defaults to DEFAULT_MAX_ATTEMPTS. */
  readonly maxAttempts?: number;
};

/** The pure integrity result, tagged with the user it was loaded for and the attempts made. */
export type EfficiencyLoadResult = DatasetIntegrityResult & {
  readonly userId: string;
  readonly attempts: number;
};

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;

/**
 * Loads requests, then stages, and checks the pair. Retries the whole load
 * only when isRetryableLoad says every error is race-related, up to
 * maxAttempts in total, with no delay. Returns the final attempt's result.
 *
 * Cancellation: the signal is passed to every query; once aborted, no
 * further query or retry starts and the result is cancelled, never a
 * dataset. Throws RangeError for invalid options (a programming error);
 * query errors are returned as load-integrity results, never thrown.
 */
export async function loadEfficiencyDataset(
  options: LoadEfficiencyDatasetOptions,
): Promise<EfficiencyLoadResult> {
  const { userId, signal } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new RangeError("userId must be the signed-in user's id.");
  }
  if (!isPositiveInteger(pageSize)) throw new RangeError("pageSize must be a positive integer.");
  if (!isPositiveInteger(maxAttempts)) {
    throw new RangeError("maxAttempts must be a positive integer.");
  }

  let attempts = 0;
  const cancelled = (): EfficiencyLoadResult => ({ status: "cancelled", userId, attempts });

  for (;;) {
    if (signal.aborted) return cancelled();
    attempts += 1;

    const requests = await readAllPages<EfficiencyRequestRow>({
      ...requestFetchers,
      requiredFields: EFFICIENCY_REQUEST_COLUMNS,
      pageSize,
      signal,
    });
    if (signal.aborted || requests.status === "cancelled") return cancelled();

    const stages = await readAllPages<EfficiencyStageRow>({
      ...stageFetchers,
      requiredFields: EFFICIENCY_STAGE_COLUMNS,
      pageSize,
      signal,
    });
    if (signal.aborted || stages.status === "cancelled") return cancelled();

    const integrity = checkDatasetIntegrity({ requests, stages });
    if (integrity.status === "cancelled") return cancelled();

    if (attempts >= maxAttempts || !isRetryableLoad({ requests, stages, integrity })) {
      return { ...integrity, userId, attempts };
    }
  }
}
