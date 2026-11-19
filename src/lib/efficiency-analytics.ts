import { calculateActiveQueueWorkload } from "@/lib/efficiency-active-queue-workload";
import type { DatasetIntegrityResult, EfficiencyRequestRow } from "@/lib/efficiency-data";
import {
  calculateApprovalRate,
  calculateRequestTurnaroundTime,
} from "@/lib/efficiency-decision-metrics";
import {
  EFFICIENCY_METRIC_IDS,
  EFFICIENCY_METRICS_VERSION,
  type EfficiencyMetricId,
} from "@/lib/efficiency-metrics";
import { calculateQueueThroughput } from "@/lib/efficiency-queue-throughput";
import { calculateRequestVolume } from "@/lib/efficiency-request-volume";
import { calculateStageProcessingTime } from "@/lib/efficiency-stage-processing-time";
import type { PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.9: the public entry point for the F19 efficiency metrics.
 *
 * Calculates every catalog metric from one F19.3 load result by calling the
 * metric's own calculator. It holds no metric rules and does no calculation
 * of its own: each calculator remains the source of truth for its value,
 * population, data-quality counts and result type.
 *
 * Load gating stays per metric. There is no global gate: each calculator
 * applies gateMetricLoad with its own catalog requiredReads and
 * loadIntegrityErrors, so a failed stage read blocks only the metrics that
 * need stages, and a failed request read only those that need requests.
 *
 * Pure and browser-safe: no I/O. Dependency direction: imports the metric
 * calculators, the catalog and F19.3/F18 types. Nothing imports it back.
 */

export type EfficiencyMetricsInput = {
  /** The F19.3 load result (DatasetIntegrityResult, or the loader's EfficiencyLoadResult). */
  readonly load: DatasetIntegrityResult;
  /**
   * The F18 reporting period for every period-assigned metric. Active Queue
   * Workload is a snapshot and never receives it.
   */
  readonly period: PeriodBounds;
  /**
   * Browser-only prototype requests. The caller MUST scope them to the
   * signed-in owner (AGENTS.md) before passing them; nothing here can check
   * ownership, and nothing here loads or infers prototypes. They are passed
   * to the metrics whose request populations can count them, and only ever
   * counted under prototype_request.
   */
  readonly prototypeRequests?: readonly EfficiencyRequestRow[];
};

/** Each catalog metric's calculator, called with the inputs that metric accepts. */
const CALCULATORS = {
  request_volume: ({ load, period, prototypeRequests }: EfficiencyMetricsInput) =>
    calculateRequestVolume({ load, period, prototypeRequests }),
  active_queue_workload: ({ load, prototypeRequests }: EfficiencyMetricsInput) =>
    calculateActiveQueueWorkload({ load, prototypeRequests }),
  stage_processing_time_average: ({ load, period }: EfficiencyMetricsInput) =>
    calculateStageProcessingTime("stage_processing_time_average", { load, period }),
  stage_processing_time_median: ({ load, period }: EfficiencyMetricsInput) =>
    calculateStageProcessingTime("stage_processing_time_median", { load, period }),
  request_turnaround_time_average: ({ load, period, prototypeRequests }: EfficiencyMetricsInput) =>
    calculateRequestTurnaroundTime("request_turnaround_time_average", {
      load,
      period,
      prototypeRequests,
    }),
  request_turnaround_time_median: ({ load, period, prototypeRequests }: EfficiencyMetricsInput) =>
    calculateRequestTurnaroundTime("request_turnaround_time_median", {
      load,
      period,
      prototypeRequests,
    }),
  approval_rate: ({ load, period, prototypeRequests }: EfficiencyMetricsInput) =>
    calculateApprovalRate({ load, period, prototypeRequests }),
  queue_throughput: ({ load, period }: EfficiencyMetricsInput) =>
    calculateQueueThroughput({ load, period }),
} as const satisfies Record<EfficiencyMetricId, (input: EfficiencyMetricsInput) => unknown>;

/** Every catalog metric's own result ("calculated", "blocked" or "cancelled"), keyed by id. */
export type EfficiencyMetricResults = {
  readonly [Id in EfficiencyMetricId]: ReturnType<(typeof CALCULATORS)[Id]>;
};

export type EfficiencyMetricsReport = {
  /** The catalog version every calculated result was produced under. */
  readonly catalogVersion: string;
  /** The reporting period given to the period-assigned metrics. */
  readonly period: PeriodBounds;
  /** Keyed by metric id, in EFFICIENCY_METRIC_IDS order. */
  readonly metrics: EfficiencyMetricResults;
};

/**
 * Calculates every F19 efficiency metric from one load result.
 *
 * Each metric gets the same `load`; every period-assigned metric gets the
 * same `period`; `prototypeRequests` go to the request-population metrics
 * (Request Volume, Request Turnaround Time, Approval Rate and the Active
 * Queue Workload pending_without_stage report). Each result is exactly what
 * the metric's calculator returned.
 *
 * Throws what the calculators throw: a RangeError for invalid period bounds
 * (even when the load is cancelled or blocked), and an Error for repeated
 * ids, which a validated F19.3 load cannot contain. Pure: does not modify
 * its inputs.
 */
export function calculateEfficiencyMetrics(input: EfficiencyMetricsInput): EfficiencyMetricsReport {
  const metrics = Object.fromEntries(
    EFFICIENCY_METRIC_IDS.map((id) => [id, CALCULATORS[id](input)]),
  ) as unknown as EfficiencyMetricResults;
  return Object.freeze({
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: Object.freeze({
      startUtc: input.period.startUtc,
      endExclusiveUtc: input.period.endExclusiveUtc,
    }),
    metrics: Object.freeze(metrics),
  });
}
