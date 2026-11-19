import {
  assertValidPeriod,
  indexReadyTables,
  periodAnchorTest,
  untaggedPopulation,
  valuesByQueueGroup,
  type MetricNotCalculated,
  type QueueGroupValues,
} from "@/lib/efficiency-calculation";
import {
  classifyMetricPopulation,
  gateMetricLoad,
  type PopulationResult,
} from "@/lib/efficiency-classification";
import type { DatasetIntegrityResult, EfficiencyStageRow } from "@/lib/efficiency-data";
import { EFFICIENCY_METRICS_VERSION } from "@/lib/efficiency-metrics";
import type { PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.6: Queue Throughput.
 *
 * Throughput(q, P) = |{ s : s.queue_id = q, s.status = 'completed',
 * s.completed_at in P }|, over the catalog's queue_throughput population.
 * It counts stage decisions, not requests: a request completing stages in
 * two queues counts once in each, and twice overall.
 *
 * Pure and browser-safe: no I/O. Everything metric-specific comes from the
 * catalog through the shared F19.4 helpers:
 * - gateMetricLoad: only the stage read is required, so a failed request
 *   read, or stage_request_not_loaded, does not block;
 * - classifyMetricPopulation: scope (stages that are not active), the four
 *   ordered exclusions and the unknown_queue flag;
 * - the catalog period anchor (approval_stage_tracking.completed_at).
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog,
 * the shared calculation steps, classification and F18 types. Nothing it
 * imports may import it back.
 */

const METRIC_ID = "queue_throughput" as const;
const METRIC_NAME = "Queue Throughput";

/** A calculated Queue Throughput for one reporting period. */
export type QueueThroughputCalculated = {
  readonly status: "calculated";
  readonly metricId: "queue_throughput";
  /** The catalog version the values were calculated under; values are comparable only within one version. */
  readonly catalogVersion: string;
  /** The half-open reporting period P: startUtc <= completed_at < endExclusiveUtc. */
  readonly period: PeriodBounds;
  /**
   * Stage decisions completed in P, including unknown-queue stages; the sum
   * of the queue counts. 0 when none (the catalog's emptyResult "zero").
   */
  readonly overall: number;
  /** A count per recognized queue (always present, 0 when none) and the unknown group (only when populated). */
  readonly queues: QueueGroupValues<number>;
  /** The stage decisions counted: included, completed in P, in input order. */
  readonly counted: readonly EfficiencyStageRow[];
  /** The stage population classified over the whole supplied dataset, not only P (DATA_QUALITY_RULES 5). */
  readonly population: PopulationResult<EfficiencyStageRow>;
};

export type QueueThroughputResult = MetricNotCalculated | QueueThroughputCalculated;

/**
 * Calculates Queue Throughput for `period` from an F19.3 load result.
 *
 * 1. The period must be valid F18 bounds, or a RangeError is thrown.
 * 2. gateMetricLoad("queue_throughput"): "cancelled" and "blocked" are
 *    returned unchanged. Only stage-read errors block; the request table is
 *    not a required read and is never used.
 * 3. Every supplied stage that is not active is classified with the catalog
 *    population over the whole dataset; active stages are outside the scope
 *    and not counted anywhere. Each excluded stage gets only its first
 *    failing condition, and unknown_queue only flags.
 * 4. The included stages whose completed_at lies in `period` are counted,
 *    each once, in its own queue group and overall.
 *
 * Throws if stage ids repeat (not a validated F19.3 load). Pure: does not
 * modify the load or the period; the result holds the caller's row objects.
 */
export function calculateQueueThroughput(input: {
  readonly load: DatasetIntegrityResult;
  readonly period: PeriodBounds;
}): QueueThroughputResult {
  const { load, period } = input;
  assertValidPeriod(METRIC_NAME, period);

  const gate = gateMetricLoad(METRIC_ID, load);
  if (gate.status !== "ready") return gate;

  // The request table is not a required read, so the gate never supplies it.
  const index = indexReadyTables(METRIC_NAME, gate.tables);
  const { population } = classifyMetricPopulation(METRIC_ID, { index });
  if (population.subject !== "stage") {
    throw new Error(`${METRIC_NAME}: the catalog population must be a stage population.`);
  }

  const inPeriod = periodAnchorTest(METRIC_NAME, METRIC_ID, "approval_stage_tracking", period);
  const counted = population.included.filter(inPeriod);

  return Object.freeze({
    status: "calculated",
    metricId: METRIC_ID,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: Object.freeze({ startUtc: period.startUtc, endExclusiveUtc: period.endExclusiveUtc }),
    overall: counted.length,
    queues: valuesByQueueGroup(counted, (stages) => stages.length),
    counted: Object.freeze(counted),
    population: untaggedPopulation(population),
  });
}
