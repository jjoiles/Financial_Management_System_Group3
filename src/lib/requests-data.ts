import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

import type { RequestStatus, FundingType, FinancialRequest } from "@/lib/mock-data";

import { logger } from "@/lib/logger";

import { readRoutingDecision, type RoutingDecision } from "@/lib/routing/engine";

import { readRequestMetadata, type RequestMetadata } from "@/lib/request-utils";

import { classifyRequestReadError, selectVisibleRequests, type RequestReadIssue } from "@/lib/request-list";
import { approvalStageClient } from "@/lib/approval-stage-client";
import { useAuth } from "@/lib/auth-context";
import { startRequestStatusChecks, type StatusSyncState } from "@/lib/request-status-sync";

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
  userId: string | null;
  createdAt: string;
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
  createdAt: row.created_at ?? "",
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
  userId: row.user_id ?? null,
  activeStage,
});

export function useFinancialRequests(opts: { onlyMine?: boolean; automatic?: boolean } = {}) {
  const { user, needsMfa } = useAuth();
  const userId = user?.id;
  const generation = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const [owner, setOwner] = useState<string | undefined>();
  const [syncState, setSyncState] = useState<StatusSyncState>("checking");
  const [data, setData] = useState<EnrichedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readIssue, setReadIssue] = useState<RequestReadIssue | null>(null);

  const load = useCallback(async (background = false): Promise<boolean> => {
    if (!userId || needsMfa) return false;
    const version = ++generation.current;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    const current = () => version === generation.current && !controller.signal.aborted;
    let successful = false;
    if (!background) setLoading(true);

    const reportReadError = (err: unknown) => {
      if (!current()) return;
      const issue = classifyRequestReadError(err);
      setError(issue.message);
      setReadIssue(issue);
    };

    try {
      let rows: DbRow[] | null = null;

      // Load financial requests.
      try {
        let query = supabase
          .from("financial_requests")
          .select("*, request_attachments(count)");
        if (opts.onlyMine) query = query.eq("user_id", userId);
        const res = await query.order("created_at", { ascending: false }).abortSignal(controller.signal);

        if (!current()) return false;

        if (res.error) {
          logger.error("requests.load_failed", { error: res.error });
          reportReadError(res.error);
        } else {
          rows = res.data as DbRow[];
          successful = true;
        }
      } catch (dbErr) {
        logger.error("requests.load_crashed", { error: dbErr });
        reportReadError(dbErr);
      }

      if (!current()) return false;

      // Load active SLA stages.
      // RLS limits the returned stages to requests the user may view.
      let activeStages: ActiveStageRow[] = [];

      try {
        const stageResult = await approvalStageClient
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

      let combined: EnrichedRequest[] = (rows ?? []).flatMap(safeMap);

      combined = selectVisibleRequests(combined, userId, !!opts.onlyMine);

      combined.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

      if (current()) {
        setOwner(userId);
        setData(combined);
        if (successful) { setError(null); setReadIssue(null); }
      }
    } catch (err) {
      logger.error("requests.load_crashed", { error: err });

      if (current()) setData([]);
      reportReadError(err);
    } finally {
      if (current()) setLoading(false);
    }
    return successful && current();
  }, [opts.onlyMine, userId, needsMfa]);

  useEffect(() => {
    generation.current += 1;
    setOwner(userId);
    setData([]);
    setError(null);
    setReadIssue(null);
    setLoading(!!userId && !needsMfa);
    if (!userId || needsMfa) return;
    let first = true;
    const stop = opts.automatic ? startRequestStatusChecks({
      refresh: () => { const background = !first; first = false; return load(background); },
      online: () => navigator.onLine,
      visible: () => document.visibilityState === "visible",
      report: state => { setSyncState(state); if (state === "offline" || state === "paused") setLoading(false); },
      every: (callback, ms) => { const timer = window.setInterval(callback, ms); return () => window.clearInterval(timer); },
      listen: (event, callback) => {
        const target = event === "visibilitychange" ? document : window;
        target.addEventListener(event, callback);
        return () => target.removeEventListener(event, callback);
      },
    }) : undefined;
    if (!opts.automatic) void load();
    return () => { stop?.(); generation.current += 1; activeRead.current?.abort(); };
  }, [load, opts.automatic, userId, needsMfa]);

  const visible = !!userId && !needsMfa && owner === userId;
  return {
    data: visible ? data : [], loading: visible ? loading : !!userId && !needsMfa,
    error: visible ? error : null, readIssue: visible ? readIssue : null,
    reload: () => load(), syncState,
  };
}

export const formatStatus = (status: RequestStatus) => status;
