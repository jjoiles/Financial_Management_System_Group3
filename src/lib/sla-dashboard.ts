import type { ApprovalStageRow } from "@/lib/approval-stage-client";
import { calculateStageSla, HOUR_IN_MS, type SlaResult } from "@/lib/sla-utils";

/**
 * Pure SLA dashboard calculations (F16).
 *
 * Browser-safe and free of React/Supabase so the dashboard page and unit
 * tests share the same rules. Per-stage SLA status and remaining time come
 * from calculateStageSla; this module only combines and summarizes them.
 */

export type SlaRequestSummary = {
  id: string;
  request_number: string;
  title: string;
  department: string;
  amount: number;
  status: string;
  routed_to: string | null;
};

/**
 * A stage row as loaded for the SLA dashboard. Picked from the shared
 * ApprovalStageRow view; excludes workflow_revision (F19.2) so the dashboard
 * still loads on a backend without that migration. Keep in sync with the
 * select list in use-sla-dashboard.ts.
 */
export type SlaStageRow = Pick<
  ApprovalStageRow,
  | "id"
  | "request_id"
  | "stage_order"
  | "queue_id"
  | "stage_name"
  | "started_at"
  | "deadline_at"
  | "completed_at"
  | "duration_hours"
  | "status"
>;

export type DashboardStage = SlaStageRow & {
  request: SlaRequestSummary | undefined;
  sla: SlaResult;
};

export type QueuePerformance = {
  queueId: string;
  name: string;
  count: number;
  averageHours: number;
};

export type SlaDashboardSummary = {
  activeStages: DashboardStage[];
  onTrackStages: DashboardStage[];
  approachingStages: DashboardStage[];
  overdueStages: DashboardStage[];
  completedStages: DashboardStage[];
  activeSorted: DashboardStage[];
  recentCompleted: DashboardStage[];
  queuePerformance: QueuePerformance[];
  totalStages: number;
  requestCount: number;
};

/** Number of completed stages shown in the recent-history table. */
export const RECENT_COMPLETED_LIMIT = 10;

/** Raw elapsed hours between two timestamps; callers apply their own guards. */
function elapsedHoursBetween(startedAt: string, completedAt: string): number {
  return (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / HOUR_IN_MS;
}

/** Builds a request lookup map. When an id repeats, the last row wins. */
export function indexRequestsById(
  rows: readonly SlaRequestSummary[],
): Record<string, SlaRequestSummary> {
  const requestMap: Record<string, SlaRequestSummary> = {};

  rows.forEach((request) => {
    requestMap[request.id] = request;
  });

  return requestMap;
}

/**
 * Attaches request details and SLA results to each stage, preserving order.
 *
 * Active stages are measured with their own completed_at (normally null, so
 * against `now`). Non-active stages fall back to started_at when completed_at
 * is missing, which makes calculateStageSla report them as completed.
 */
export function buildDashboardStages(
  stages: readonly SlaStageRow[],
  requestsById: Record<string, SlaRequestSummary>,
  now: Date,
): DashboardStage[] {
  return stages.map((stage) => ({
    ...stage,
    request: requestsById[stage.request_id],
    sla: calculateStageSla(
      {
        stageName: stage.stage_name,
        startedAt: stage.started_at,
        durationHours: stage.duration_hours,
        completedAt:
          stage.status === "active" ? stage.completed_at : (stage.completed_at ?? stage.started_at),
      },
      now,
    ),
  }));
}

/**
 * Average actual processing time per approval queue.
 *
 * Skips stages without completed_at and stages whose elapsed duration is
 * non-finite or negative. Queues appear in first-seen order and take the
 * stage name of the first stage seen for that queue.
 */
export function calculateQueuePerformance(
  completedStages: readonly SlaStageRow[],
): QueuePerformance[] {
  const groups = new Map<string, { name: string; totalHours: number; count: number }>();

  completedStages.forEach((stage) => {
    if (!stage.completed_at) return;

    const durationHours = elapsedHoursBetween(stage.started_at, stage.completed_at);

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
}

/**
 * Processing time shown in the completed-history table.
 *
 * Returns 0 when completed_at is missing. Intentionally unguarded otherwise:
 * unlike calculateQueuePerformance, negative or invalid durations pass through.
 */
export function getCompletedStageElapsedHours(
  stage: Pick<SlaStageRow, "started_at" | "completed_at">,
): number {
  return stage.completed_at ? elapsedHoursBetween(stage.started_at, stage.completed_at) : 0;
}

/** Groups, sorts and counts dashboard stages without mutating the input. */
export function summarizeDashboardStages(stages: readonly DashboardStage[]): SlaDashboardSummary {
  const activeStages = stages.filter((stage) => stage.status === "active");

  const approachingStages = activeStages.filter((stage) => stage.sla.status === "approaching");

  const overdueStages = activeStages.filter((stage) => stage.sla.status === "overdue");

  const completedStages = stages.filter((stage) => stage.status === "completed");

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
    .slice(0, RECENT_COMPLETED_LIMIT);

  return {
    activeStages,
    onTrackStages,
    approachingStages,
    overdueStages,
    completedStages,
    activeSorted,
    recentCompleted,
    queuePerformance: calculateQueuePerformance(completedStages),
    totalStages: stages.length,
    requestCount: new Set(stages.map((stage) => stage.request_id)).size,
  };
}

/** Human-readable duration; negative values are formatted by magnitude. */
export function formatDuration(hours: number): string {
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

/** Watchlist "Remaining" cell text; zero remaining is not overdue. */
export function formatRemainingTime(remainingHours: number): string {
  return remainingHours < 0
    ? `Overdue by ${formatDuration(remainingHours)}`
    : `${formatDuration(remainingHours)} left`;
}

/** Locale date-time text, "—" for missing values, "Invalid date" for bad input. */
export function formatDate(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Invalid date";

  return date.toLocaleString();
}
