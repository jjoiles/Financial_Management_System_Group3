import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RequestStatus, FundingType, FinancialRequest } from "@/lib/mock-data";
import { logger } from "@/lib/logger";
import { readRoutingDecision, type RoutingDecision } from "@/lib/routing/engine";
import { readRequestMetadata, type RequestMetadata } from "@/lib/request-utils";
import { readPrototypeRequests as readPrototypeRequestStore } from "@/lib/prototype-store";

type DbRow = {
  id: string;
  request_number: string;
  user_id: string;
  title: string;
  requester_email: string;
  department: string;
  funding_source: "department" | "research" | "university";
  amount: number | string;
  needed_by: string;
  priority: "low" | "medium" | "high";
  description: string;
  status: "submitted" | "under_review" | "approved" | "rejected" | "completed";
  created_at: string;
  updated_at: string;
  routed_to: string | null;
  metadata?: Record<string, unknown>;
  // F6: embedded count of linked attachment rows
  request_attachments?: { count: number }[];
  prototype?: boolean;
};

const fundingMap: Record<DbRow["funding_source"], FundingType> = {
  department: "Department",
  research: "R",
  university: "U",
};

const statusMap: Record<DbRow["status"], RequestStatus> = {
  submitted: "Submitted",
  under_review: "Under Review",
  approved: "Approved",
  rejected: "Rejected",
  completed: "Completed",
};

const priorityMap = { low: "Low", medium: "Medium", high: "High" } as const;

export type EnrichedRequest = FinancialRequest & {
  uuid: string;
  email: string;
  neededBy: string;
  routedTo: string | null;
  routing: RoutingDecision | null;
  metadata?: RequestMetadata | null;
  prototype: boolean;
  userId: string | null;
};

const toEnriched = (row: DbRow, fallbackName?: string): EnrichedRequest => ({
  uuid: row.id,
  id: row.request_number,
  title: row.title,
  requester: fallbackName ?? row.requester_email,
  email: row.requester_email,
  department: row.department,
  fundingType: fundingMap[row.funding_source],
  amount: Number(row.amount),
  status: statusMap[row.status],
  submittedAt: (row.created_at ?? "").slice(0, 10),
  // Prototype (local) rows have no updated_at; fall back to created_at.
  updatedAt: (row.updated_at ?? row.created_at ?? "").slice(0, 10),
  description: row.description,
  attachments:
    row.request_attachments?.[0]?.count ??
    Number((row.metadata as { attachmentCount?: number } | undefined)?.attachmentCount ?? 0),
  priority: priorityMap[row.priority],
  neededBy: row.needed_by,
  routedTo: row.routed_to,
  routing: readRoutingDecision(row.metadata),
  metadata: readRequestMetadata(row.metadata),
  prototype: !!row.prototype,
  userId: row.user_id ?? null,
});

export const readPrototypeRequests = (): DbRow[] => readPrototypeRequestStore<DbRow>();

export function useFinancialRequests(opts: { onlyMine?: boolean } = {}) {
  const [data, setData] = useState<EnrichedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Backend failures must never hide locally saved prototype requests.
      let rows: DbRow[] | null = null;
      try {
        const res = await (supabase as any)
          .from("financial_requests")
          .select("*, request_attachments(count)")
          .order("created_at", { ascending: false });
        if (res.error) {
          logger.error("requests.load_failed", { error: res.error });
          setError(res.error.message);
        } else rows = res.data as DbRow[];
      } catch (dbErr) {
        logger.error("requests.load_crashed", { error: dbErr });
        setError(dbErr instanceof Error ? dbErr.message : "Failed to load requests");
      }

      let currentUserId: string | undefined;
      try {
        currentUserId = (await supabase.auth.getSession()).data.session?.user.id;
      } catch {
        currentUserId = undefined;
      }

      const safeMap = (r: DbRow) => {
        try {
          return [toEnriched(r)];
        } catch (mapErr) {
          logger.warn("requests.row_skipped", { id: r?.id, error: mapErr });
          return [];
        }
      };

      let combined: EnrichedRequest[] = (rows ?? []).flatMap(safeMap);
      const proto = readPrototypeRequests().flatMap((r) => safeMap({ ...r, prototype: true }));
      combined = [...combined, ...proto];

      if (opts.onlyMine) {
        combined = currentUserId ? combined.filter((r) => r.userId === currentUserId) : [];
      }

      combined.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
      setData(combined);
    } catch (err) {
      logger.error("requests.load_crashed", { error: err });
      setError(err instanceof Error ? err.message : "Failed to load requests");
    } finally {
      setLoading(false);
    }
  }, [opts.onlyMine]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}

export const formatStatus = (s: RequestStatus) => s;
