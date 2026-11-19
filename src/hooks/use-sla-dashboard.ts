import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { approvalStageClient } from "@/lib/approval-stage-client";
import { indexRequestsById, type SlaRequestSummary, type SlaStageRow } from "@/lib/sla-dashboard";

export type SlaDashboardData = {
  stages: SlaStageRow[];
  requestsById: Record<string, SlaRequestSummary>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
};

/**
 * Reads approval stages and their request summaries. RLS limits both reads to
 * rows the signed-in user may view. Throws with a user-facing message when
 * either read fails.
 */
async function fetchSlaDashboardData(): Promise<{
  stages: SlaStageRow[];
  requestsById: Record<string, SlaRequestSummary>;
}> {
  const { data: stageData, error: stageError } = await approvalStageClient
    .from("approval_stage_tracking")
    .select(
      "id, request_id, stage_order, queue_id, stage_name, started_at, deadline_at, completed_at, duration_hours, status",
    )
    .order("started_at", { ascending: false });

  if (stageError) {
    throw new Error(`Could not load SLA stages: ${stageError.message}`);
  }

  const stageRows = (stageData ?? []) as SlaStageRow[];

  const requestIds = [...new Set(stageRows.map((stage) => stage.request_id))];

  let requestRows: SlaRequestSummary[] = [];

  if (requestIds.length > 0) {
    const { data: requestData, error: requestError } = await supabase
      .from("financial_requests")
      .select("id, request_number, title, department, amount, status, routed_to")
      .in("id", requestIds);

    if (requestError) {
      throw new Error(`Could not load request details: ${requestError.message}`);
    }

    requestRows = (requestData ?? []) as SlaRequestSummary[];
  }

  return { stages: stageRows, requestsById: indexRequestsById(requestRows) };
}

/**
 * SLA dashboard data and load state.
 *
 * `loading` is true only until the first load settles; `refreshing` is true
 * during every load, including the first. A failed load sets `error` and
 * keeps the previously loaded data and `lastUpdated`.
 */
export function useSlaDashboard(): SlaDashboardData {
  const [stages, setStages] = useState<SlaStageRow[]>([]);

  const [requestsById, setRequestsById] = useState<Record<string, SlaRequestSummary>>({});

  const [loading, setLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    try {
      const result = await fetchSlaDashboardData();

      setStages(result.stages);
      setRequestsById(result.requestsById);
      setLastUpdated(new Date());
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Unable to load the SLA dashboard.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stages, requestsById, loading, refreshing, error, lastUpdated, refresh };
}
