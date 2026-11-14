import { createFileRoute } from "@tanstack/react-router";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Activity, AlertTriangle, CheckCircle2, Clock3, RefreshCw, Timer } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

import { calculateStageSla } from "@/lib/sla-utils";

import { formatCurrency } from "@/lib/format";

export const Route = createFileRoute("/sla")({
  component: SlaDashboardPage,
  head: () => ({
    meta: [
      { title: "SLA Dashboard — FinReq" },
      {
        name: "description",
        content: "Monitor financial request approval deadlines and SLA performance.",
      },
    ],
  }),
});

type StageRow = {
  id: string;
  request_id: string;
  stage_order: number;
  queue_id: string;
  stage_name: string;
  started_at: string;
  deadline_at: string;
  completed_at: string | null;
  duration_hours: number;
  status: string;
};

type RequestSummary = {
  id: string;
  request_number: string;
  title: string;
  department: string;
  amount: number;
  status: string;
  routed_to: string | null;
};

type DashboardStage = StageRow & {
  request: RequestSummary | undefined;
  sla: ReturnType<typeof calculateStageSla>;
};

function formatDuration(hours: number): string {
  const absolute = Math.abs(hours);

  const days = Math.floor(absolute / 24);
  const remainingHours = Math.floor(absolute % 24);
  const minutes = Math.floor((absolute * 60) % 60);

  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (remainingHours > 0) parts.push(`${remainingHours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  return parts.length ? parts.join(" ") : "Less than 1 minute";
}

function formatDate(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Invalid date";

  return date.toLocaleString();
}

function SlaBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    on_track: "bg-success/10 text-success",
    approaching: "bg-warning/15 text-warning",
    overdue: "bg-destructive/10 text-destructive",
    completed: "bg-primary/10 text-primary",
    skipped: "bg-muted text-muted-foreground",
    cancelled: "bg-muted text-muted-foreground",
  };

  const labels: Record<string, string> = {
    on_track: "On Track",
    approaching: "Approaching",
    overdue: "Overdue",
    completed: "Completed",
    skipped: "Skipped",
    cancelled: "Cancelled",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
        styles[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function SlaDashboardPage() {
  const [stages, setStages] = useState<StageRow[]>([]);

  const [requestsById, setRequestsById] = useState<Record<string, RequestSummary>>({});

  const [loading, setLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadDashboard = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    try {
      const { data: stageData, error: stageError } = await supabase
        .from("approval_stage_tracking")
        .select(
          "id, request_id, stage_order, queue_id, stage_name, started_at, deadline_at, completed_at, duration_hours, status",
        )
        .order("started_at", { ascending: false });

      if (stageError) {
        throw new Error(`Could not load SLA stages: ${stageError.message}`);
      }

      const stageRows = (stageData ?? []) as StageRow[];

      const requestIds = [...new Set(stageRows.map((stage) => stage.request_id))];

      let requestRows: RequestSummary[] = [];

      if (requestIds.length > 0) {
        const { data: requestData, error: requestError } = await supabase
          .from("financial_requests")
          .select("id, request_number, title, department, amount, status, routed_to")
          .in("id", requestIds);

        if (requestError) {
          throw new Error(`Could not load request details: ${requestError.message}`);
        }

        requestRows = (requestData ?? []) as RequestSummary[];
      }

      const requestMap: Record<string, RequestSummary> = {};

      requestRows.forEach((request) => {
        requestMap[request.id] = request;
      });

      setStages(stageRows);
      setRequestsById(requestMap);
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
    void loadDashboard();
  }, [loadDashboard]);

  const dashboardStages = useMemo<DashboardStage[]>(() => {
    const now = new Date();

    return stages.map((stage) => ({
      ...stage,
      request: requestsById[stage.request_id],
      sla: calculateStageSla(
        {
          stageName: stage.stage_name,
          startedAt: stage.started_at,
          durationHours: stage.duration_hours,
          completedAt:
            stage.status === "active"
              ? stage.completed_at
              : (stage.completed_at ?? stage.started_at),
        },
        now,
      ),
    }));
  }, [stages, requestsById]);

  const activeStages = dashboardStages.filter((stage) => stage.status === "active");

  const approachingStages = activeStages.filter((stage) => stage.sla.status === "approaching");

  const overdueStages = activeStages.filter((stage) => stage.sla.status === "overdue");

  const completedStages = dashboardStages.filter((stage) => stage.status === "completed");

  const onTrackStages = activeStages.filter((stage) => stage.sla.status === "on_track");

  const activeSorted = [...activeStages].sort(
    (a, b) => a.sla.remainingHours - b.sla.remainingHours,
  );

  const recentCompleted = [...completedStages]
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.started_at).getTime() -
        new Date(a.completed_at ?? a.started_at).getTime(),
    )
    .slice(0, 10);

  const queuePerformance = useMemo(() => {
    const groups = new Map<string, { name: string; totalHours: number; count: number }>();

    completedStages.forEach((stage) => {
      if (!stage.completed_at) return;

      const durationHours =
        (new Date(stage.completed_at).getTime() - new Date(stage.started_at).getTime()) /
        (60 * 60 * 1000);

      if (!Number.isFinite(durationHours) || durationHours < 0) return;

      const existing = groups.get(stage.queue_id);

      if (existing) {
        existing.totalHours += durationHours;
        existing.count += 1;
      } else {
        groups.set(stage.queue_id, {
          name: stage.stage_name,
          totalHours: durationHours,
          count: 1,
        });
      }
    });

    return [...groups.entries()].map(([queueId, group]) => ({
      queueId,
      name: group.name,
      count: group.count,
      averageHours: group.totalHours / group.count,
    }));
  }, [completedStages]);

  const kpis = [
    {
      label: "Active Stages",
      value: activeStages.length,
      description: "Currently awaiting review",
      icon: Activity,
      iconColor: "text-primary",
    },
    {
      label: "Approaching Deadline",
      value: approachingStages.length,
      description: "Within 24 hours of deadline",
      icon: Clock3,
      iconColor: "text-warning",
    },
    {
      label: "Overdue",
      value: overdueStages.length,
      description: "Past their SLA deadline",
      icon: AlertTriangle,
      iconColor: "text-destructive",
    },
    {
      label: "Completed Stages",
      value: completedStages.length,
      description: "Successfully completed",
      icon: CheckCircle2,
      iconColor: "text-success",
    },
  ];

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
          Loading SLA monitoring data...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Timer className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-wide">
              Financial Operations
            </span>
          </div>

          <h1 className="mt-2 text-2xl font-bold text-foreground">SLA Monitoring Dashboard</h1>

          <p className="mt-1 text-sm text-muted-foreground">
            Monitor approval deadlines, processing performance, and overdue requests across all
            review queues.
          </p>

          {lastUpdated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => void loadDashboard()}
          disabled={refreshing}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh Data
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;

          return (
            <div key={kpi.label} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{kpi.label}</p>

                <Icon className={`h-5 w-5 ${kpi.iconColor}`} />
              </div>

              <p className="mt-3 text-3xl font-bold text-card-foreground">{kpi.value}</p>

              <p className="mt-1 text-xs text-muted-foreground">{kpi.description}</p>
            </div>
          );
        })}
      </div>

      {/* SLA Health */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold text-card-foreground">Active SLA Health</h2>

        <p className="mt-1 text-sm text-muted-foreground">
          Current distribution of active approval stages.
        </p>

        <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-muted">
          {activeStages.length > 0 && (
            <>
              <div
                className="bg-success"
                style={{
                  width: `${(onTrackStages.length / activeStages.length) * 100}%`,
                }}
              />

              <div
                className="bg-warning"
                style={{
                  width: `${(approachingStages.length / activeStages.length) * 100}%`,
                }}
              />

              <div
                className="bg-destructive"
                style={{
                  width: `${(overdueStages.length / activeStages.length) * 100}%`,
                }}
              />
            </>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-5 text-xs">
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full bg-success" />
            On Track: {onTrackStages.length}
          </span>

          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full bg-warning" />
            Approaching: {approachingStages.length}
          </span>

          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full bg-destructive" />
            Overdue: {overdueStages.length}
          </span>
        </div>
      </section>

      {/* Active SLA Watchlist */}
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-card-foreground">Active SLA Watchlist</h2>

              <p className="mt-1 text-sm text-muted-foreground">
                Approval stages ordered by their remaining time.
              </p>
            </div>

            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              {activeStages.length} active
            </span>
          </div>
        </div>

        {activeSorted.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No active approval stages found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-3">Request</th>
                  <th className="px-5 py-3">Department</th>
                  <th className="px-5 py-3">Approval Queue</th>
                  <th className="px-5 py-3">Deadline</th>
                  <th className="px-5 py-3">Remaining</th>
                  <th className="px-5 py-3">SLA Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {activeSorted.map((stage) => (
                  <tr key={stage.id} className="hover:bg-muted/20">
                    <td className="px-5 py-4">
                      <p className="font-mono text-xs text-primary">
                        {stage.request?.request_number ?? "Unavailable"}
                      </p>

                      <p className="mt-1 max-w-48 truncate font-medium text-foreground">
                        {stage.request?.title ?? "Request details unavailable"}
                      </p>
                    </td>

                    <td className="px-5 py-4 text-muted-foreground">
                      {stage.request?.department ?? "—"}
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-medium text-foreground">{stage.stage_name}</p>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Stage {stage.stage_order}
                      </p>
                    </td>

                    <td className="whitespace-nowrap px-5 py-4 text-xs text-muted-foreground">
                      {formatDate(stage.deadline_at)}
                    </td>

                    <td className="whitespace-nowrap px-5 py-4 font-medium text-foreground">
                      {stage.sla.remainingHours < 0
                        ? `Overdue by ${formatDuration(stage.sla.remainingHours)}`
                        : `${formatDuration(stage.sla.remainingHours)} left`}
                    </td>

                    <td className="px-5 py-4">
                      <SlaBadge status={stage.sla.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Queue Performance */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold text-card-foreground">
          Average Processing Time by Queue
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          Actual elapsed time calculated from completed approval stages.
        </p>

        {queuePerformance.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground">
            No completed stage history is available yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Approval Queue</th>
                  <th className="px-4 py-3 text-right">Completed Stages</th>
                  <th className="px-4 py-3 text-right">Average Processing Time</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {queuePerformance.map((queue) => (
                  <tr key={queue.queueId}>
                    <td className="px-4 py-3 font-medium text-foreground">{queue.name}</td>

                    <td className="px-4 py-3 text-right text-muted-foreground">{queue.count}</td>

                    <td className="px-4 py-3 text-right font-medium text-foreground">
                      {formatDuration(queue.averageHours)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Completed Stage History */}
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-5">
          <h2 className="text-base font-semibold text-card-foreground">
            Recent Completed Approval Stages
          </h2>

          <p className="mt-1 text-sm text-muted-foreground">Recently completed SLA records.</p>
        </div>

        {recentCompleted.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No completed stages found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-3">Request</th>
                  <th className="px-5 py-3">Approval Queue</th>
                  <th className="px-5 py-3">Started</th>
                  <th className="px-5 py-3">Completed</th>
                  <th className="px-5 py-3">Processing Time</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {recentCompleted.map((stage) => {
                  const elapsedHours = stage.completed_at
                    ? (new Date(stage.completed_at).getTime() -
                        new Date(stage.started_at).getTime()) /
                      (60 * 60 * 1000)
                    : 0;

                  return (
                    <tr key={stage.id}>
                      <td className="px-5 py-4 font-mono text-xs text-primary">
                        {stage.request?.request_number ?? "Unavailable"}
                      </td>

                      <td className="px-5 py-4 text-foreground">{stage.stage_name}</td>

                      <td className="whitespace-nowrap px-5 py-4 text-xs text-muted-foreground">
                        {formatDate(stage.started_at)}
                      </td>

                      <td className="whitespace-nowrap px-5 py-4 text-xs text-muted-foreground">
                        {formatDate(stage.completed_at)}
                      </td>

                      <td className="whitespace-nowrap px-5 py-4 text-foreground">
                        {formatDuration(elapsedHours)}
                      </td>

                      <td className="px-5 py-4">
                        <SlaBadge status="completed" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Summary Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        <span>Total tracked stages: {dashboardStages.length}</span>

        <span>Requests represented: {new Set(stages.map((stage) => stage.request_id)).size}</span>

        <span>Active stages: {activeStages.length}</span>
      </div>
    </div>
  );
}
