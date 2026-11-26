import { buildRequestListCsv, type RequestListExportRow } from "./csv-export";
import type { RequestReadIssue } from "./request-list";

export type RequestExportContext = {
  userId?: string;
  loading: boolean;
  needsMfa: boolean;
  readIssue: RequestReadIssue | null;
};

export function requestExportBlockReason(context: RequestExportContext, count: number): string | null {
  if (!context.userId || context.needsMfa) return "Sign in and complete verification to export requests.";
  if (context.loading) return "Wait for requests to finish loading.";
  if (context.readIssue?.kind === "access") return "Access restricted. Export is unavailable for this request view.";
  if (context.readIssue) return "Export is unavailable until the request list loads successfully. Refresh to try again.";
  if (!count) return "No matching requests to export.";
  return null;
}

/** Accept only the displayed, RLS-loaded rows, never fetch an unfiltered dataset. */
export function prepareRequestExport<T extends RequestListExportRow & { userId: string | null }>(
  visibleRows: readonly T[], context: RequestExportContext, now = new Date(),
) {
  const reason = requestExportBlockReason(context, visibleRows.length);
  if (reason) throw new Error(reason);
  return {
    csv: buildRequestListCsv(visibleRows),
    filename: `financial-requests-${now.toISOString().slice(0, 10)}.csv`,
    count: visibleRows.length,
  };
}
