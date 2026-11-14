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
  request_attachments?: { count: number }[];
  prototype?: boolean;
};

type ActiveStageRow = {
  id: string;
  request_id: string;
  stage_order: number;
  queue_id: string;
  stage_name: string;
  started_at: string;
  deadline_at: string;
  duration_hours: number;
};

export type ActiveApprovalStage = {
  id: string;
  stageOrder: number;
  queueId: string;
  stageName: string;
  startedAt: string;
  deadlineAt: string;
  durationHours: number;
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

const priorityMap = {
  low: "Low",
  medium: "Medium",
  high: "High",
} as const;

export type EnrichedRequest = FinancialRequest & {
  uuid: string;
  email: string;
  neededBy: string;
  routedTo: string | null;
  routing: RoutingDecision | null;
  metadata?: RequestMetadata | null;
  prototype: boolean;
  userId: string | null;
  activeStage: ActiveApprovalStage | null;
};

const toEnriched = (
  row: DbRow,
  fallbackName?: string,
  activeStage: ActiveApprovalStage | null = null,
): EnrichedRequest => ({
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
  activeStage,
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
      let rows: DbRow[] | null = null;

      // Load financial requests.
      try {
        const res = await supabase
          .from("financial_requests")
          .select("*, request_attachments(count)")
          .order("created_at", { ascending: false });

        if (res.error) {
          logger.error("requests.load_failed", { error: res.error });
          setError(res.error.message);
        } else {
          rows = res.data as DbRow[];
        }
      } catch (dbErr) {
        logger.error("requests.load_crashed", { error: dbErr });
        setError(dbErr instanceof Error ? dbErr.message : "Failed to load requests");
      }

      // Load active SLA stages.
      // RLS limits the returned stages to requests the user may view.
      let activeStages: ActiveStageRow[] = [];

      try {
        const stageResult = await supabase
          .from("approval_stage_tracking")
          .select(
            "id, request_id, stage_order, queue_id, stage_name, started_at, deadline_at, duration_hours",
          )
          .eq("status", "active");

        if (stageResult.error) {
          logger.warn("requests.active_stages_load_failed", {
            error: stageResult.error,
          });
        } else {
          activeStages = stageResult.data ?? [];
        }
      } catch (stageError) {
        logger.warn("requests.active_stages_load_crashed", {
          error: stageError,
        });
      }

      // Match active stages to their financial requests.
      const activeStageByRequestId = new Map<string, ActiveApprovalStage>();

      for (const stage of activeStages) {
        activeStageByRequestId.set(stage.request_id, {
          id: stage.id,
          stageOrder: stage.stage_order,
          queueId: stage.queue_id,
          stageName: stage.stage_name,
          startedAt: stage.started_at,
          deadlineAt: stage.deadline_at,
          durationHours: stage.duration_hours,
        });
      }

      let currentUserId: string | undefined;

      try {
        currentUserId = (await supabase.auth.getSession()).data.session?.user.id;
      } catch {
        currentUserId = undefined;
      }

      const safeMap = (row: DbRow): EnrichedRequest[] => {
        try {
          const activeStage = activeStageByRequestId.get(row.id) ?? null;

          return [toEnriched(row, undefined, activeStage)];
        } catch (mapErr) {
          logger.warn("requests.row_skipped", {
            id: row?.id,
            error: mapErr,
          });

          return [];
        }
      };

      // Preserve locally saved prototype requests.
      let combined: EnrichedRequest[] = (rows ?? []).flatMap(safeMap);

      const proto = readPrototypeRequests().flatMap((row) => safeMap({ ...row, prototype: true }));

      combined = [...combined, ...proto];

      if (opts.onlyMine) {
        combined = currentUserId
          ? combined.filter((request) => request.userId === currentUserId)
          : [];
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

export const formatStatus = (status: RequestStatus) => status;
