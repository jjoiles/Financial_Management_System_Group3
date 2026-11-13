import { SLA_APPROACHING_THRESHOLD_HOURS } from "@/lib/sla-config";

export type SlaStatus = "on_track" | "approaching" | "overdue" | "completed";

export type SlaStage = {
  stageName: string;
  startedAt: string;
  durationHours: number;
  completedAt?: string | null;
};

export type SlaResult = {
  stageName: string;
  deadline: string;
  elapsedHours: number;
  remainingHours: number;
  status: SlaStatus;
};

const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * Calculates SLA status for one approval stage.
 *
 * The approaching threshold is configurable in sla-config.ts.
 * A completed stage is never considered overdue.
 */
export function calculateStageSla(
  stage: SlaStage,
  now: Date = new Date(),
  approachingWithinHours = SLA_APPROACHING_THRESHOLD_HOURS,
): SlaResult {
  if (stage.durationHours < 0 || approachingWithinHours < 0) {
    throw new Error("SLA durations and thresholds cannot be negative.");
  }

  const start = new Date(stage.startedAt);

  if (Number.isNaN(start.getTime())) {
    throw new Error("Invalid stage start date.");
  }

  const end = stage.completedAt ? new Date(stage.completedAt) : null;

  if (end && (Number.isNaN(end.getTime()) || end < start)) {
    throw new Error("Invalid stage completion date.");
  }

  const deadlineMs = start.getTime() + stage.durationHours * HOUR_IN_MS;
  const comparisonTime = end ?? now;

  const elapsedHours =
    (comparisonTime.getTime() - start.getTime()) / HOUR_IN_MS;

  const remainingHours =
    (deadlineMs - comparisonTime.getTime()) / HOUR_IN_MS;

  let status: SlaStatus;

  if (end) {
    status = "completed";
  } else if (remainingHours < 0) {
    status = "overdue";
  } else if (remainingHours <= approachingWithinHours) {
    status = "approaching";
  } else {
    status = "on_track";
  }

  return {
    stageName: stage.stageName,
    deadline: new Date(deadlineMs).toISOString(),
    elapsedHours: Math.max(0, elapsedHours),
    remainingHours,
    status,
  };
}
