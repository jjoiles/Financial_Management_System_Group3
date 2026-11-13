import type { QueueId } from "@/lib/routing/rules";

/**
 * F16: Configurable processing deadlines for approval queues.
 *
 * Values are expressed in hours.
 * These are initial application defaults and can be adjusted
 * when the project team confirms its official SLA policy.
 */

export const SLA_DURATIONS_HOURS: Record<QueueId, number> = {
  department_budget: 72,
  research_admin: 72,
  provost_finance: 72,
  sponsored_programs: 96,
  dean_office: 72,
  cfo_office: 48,
};

export const SLA_APPROACHING_THRESHOLD_HOURS = 24;

/**
 * Returns the configured processing deadline for an approval queue.
 */
export function getSlaDurationHours(queue: QueueId): number {
  return SLA_DURATIONS_HOURS[queue];
}