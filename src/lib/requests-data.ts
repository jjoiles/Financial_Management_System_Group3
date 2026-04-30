import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RequestStatus, FundingType, FinancialRequest } from "@/lib/mock-data";

const PROTOTYPE_KEY = "prototype-financial-requests";

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
  prototype: boolean;
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
  submittedAt: row.created_at.slice(0, 10),
  updatedAt: row.updated_at.slice(0, 10),
  description: row.description,
  attachments: 0,
  priority: priorityMap[row.priority],
  neededBy: row.needed_by,
  routedTo: row.routed_to,
  prototype: !!row.prototype,
});

export const readPrototypeRequests = (): DbRow[] => {
  try {
    return JSON.parse(window.localStorage.getItem(PROTOTYPE_KEY) ?? "[]");
  } catch {
    return [];
  }
};

export function useFinancialRequests(opts: { onlyMine?: boolean } = {}) {
  const [data, setData] = useState<EnrichedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: rows, error: dbError } = await (supabase as any)
        .from("financial_requests")
        .select("*")
        .order("created_at", { ascending: false });

      const userResult = await supabase.auth.getUser();
      const currentUserId = userResult.data.user?.id;

      let combined: EnrichedRequest[] = [];
      if (!dbError && rows) {
        combined = (rows as DbRow[]).map((r) => toEnriched(r));
      } else if (dbError) {
        setError(dbError.message);
      }

      const proto = readPrototypeRequests().map((r) => toEnriched({ ...r, prototype: true }));
      combined = [...combined, ...proto];

      if (opts.onlyMine && currentUserId) {
        combined = combined.filter((r) => proto.find((p) => p.uuid === r.uuid) || rows?.find((row: DbRow) => row.id === r.uuid && row.user_id === currentUserId));
      }

      combined.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
      setData(combined);
    } catch (err) {
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
