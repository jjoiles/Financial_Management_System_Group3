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
import { EFFICIENCY_METRICS, EFFICIENCY_METRICS_VERSION } from "@/lib/efficiency-metrics";
import { average, hoursBetween, median, type Statistic } from "@/lib/efficiency-stats";
import type { PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.6: Stage Processing Time (average and median).
 *
 * d(s) = (s.completed_at - s.started_at) / 3,600,000 ms, over the catalog's
 * stage_processing_time population, for stages whose completed_at (the
 * catalog anchor) lies in the reporting period. One value per queue group
 * and one pooled overall value, never an average of group values.
 *
 * Pure and browser-safe: no I/O. Everything metric-specific comes from the
 * catalog through the shared F19.4 helpers:
 * - gateMetricLoad: both reads are required, so a failed, incomplete or
 *   field-missing request or stage read, or stage_request_not_loaded, blocks;
 * - classifyMetricPopulation: scope (every stage), the six ordered
 *   exclusions and the unknown_queue flag;
 * - the catalog statistic (average or median) and period anchor.
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog,
 * the shared calculation steps, classification, the stats helpers and F18
 * types. Nothing it imports may import it back.
 */

const METRIC_NAME = "Stage Processing Time";

export type StageProcessingTimeMetricId =
  | "stage_processing_time_average"
  | "stage_processing_time_median";

/** One group's statistic over its n stage durations; no-data when n = 0, never 0. */
export type StageDurationStatistic = { readonly n: number; readonly value: Statistic };

/** A calculated Stage Processing Time for one reporting period. */
export type StageProcessingTimeCalculated = {
  readonly status: "calculated";
  readonly metricId: StageProcessingTimeMetricId;
  /** The catalog statistic of `metricId`. */
  readonly statistic: "average" | "median";
  /** The catalog version the values were calculated under; values are comparable only within one version. */
  readonly catalogVersion: string;
  /** The half-open reporting period P: startUtc <= completed_at < endExclusiveUtc. */
  readonly period: PeriodBounds;
  /** Pooled over every counted stage, including unknown-queue stages. In hours. */
  readonly overall: StageDurationStatistic;
  /** One value per recognized queue (always present) and the unknown group (only when populated). */
  readonly queues: QueueGroupValues<StageDurationStatistic>;
  /** The stages whose durations were used: included, completed in P, in input order. */
  readonly counted: readonly EfficiencyStageRow[];
  /**
   * The stage population classified over the whole supplied dataset, not
   * only P (DATA_QUALITY_RULES 5). Average and median share it.
   */
  readonly population: PopulationResult<EfficiencyStageRow>;
};

export type StageProcessingTimeResult = MetricNotCalculated | StageProcessingTimeCalculated;

/** The duration of an included stage. The population guarantees it exists. */
function durationHours(stage: EfficiencyStageRow): number {
  const elapsed = hoursBetween(stage.started_at, stage.completed_at);
  if (!elapsed.ok) {
    throw new Error(
      `${METRIC_NAME}: included stage ${stage.id} has no valid duration (${elapsed.reason}).`,
    );
  }
  return elapsed.hours;
}

/**
 * Calculates average or median Stage Processing Time for `period` from an
 * F19.3 load result.
 *
 * 1. The period must be valid F18 bounds, or a RangeError is thrown.
 * 2. gateMetricLoad(metricId): "cancelled" and "blocked" are returned
 *    unchanged, with every load error detail.
 * 3. Every supplied stage is classified with the catalog population over
 *    the whole dataset; each excluded stage gets only its first failing
 *    condition, and unknown_queue only flags.
 * 4. The included stages whose completed_at lies in `period` are counted,
 *    whatever their request's status or workflow revision, however long
 *    before the period they started.
 * 5. Their durations (hoursBetween) give the catalog statistic per queue
 *    group and pooled overall; an empty group is no-data.
 *
 * Throws if ids repeat (not a validated F19.3 load). Pure: does not modify
 * the load or the period; the result holds the caller's row objects.
 */
export function calculateStageProcessingTime(
  metricId: StageProcessingTimeMetricId,
  input: { readonly load: DatasetIntegrityResult; readonly period: PeriodBounds },
): StageProcessingTimeResult {
  const { load, period } = input;
  assertValidPeriod(METRIC_NAME, period);

  const metric = EFFICIENCY_METRICS[metricId];
  if (metric.family !== "stage_processing_time") {
    throw new Error(`${METRIC_NAME}: ${metricId} is not a stage processing time metric.`);
  }
  const { statistic } = metric;
  if (statistic !== "average" && statistic !== "median") {
    throw new Error(`${METRIC_NAME}: unsupported catalog statistic "${statistic}".`);
  }
  const statisticOf = statistic === "average" ? average : median;

  const gate = gateMetricLoad(metricId, load);
  if (gate.status !== "ready") return gate;

  const index = indexReadyTables(METRIC_NAME, gate.tables);
  const { population } = classifyMetricPopulation(metricId, { index });
  if (population.subject !== "stage") {
    throw new Error(`${METRIC_NAME}: the catalog population must be a stage population.`);
  }

  const inPeriod = periodAnchorTest(METRIC_NAME, metricId, "approval_stage_tracking", period);
  const counted = population.included.filter(inPeriod);
  const hours = new Map(counted.map((stage) => [stage, durationHours(stage)]));
  const summarize = (stages: readonly EfficiencyStageRow[]): StageDurationStatistic =>
    Object.freeze({
      n: stages.length,
      value: statisticOf(stages.map((stage) => hours.get(stage) ?? durationHours(stage))),
    });

  return Object.freeze({
    status: "calculated",
    metricId,
    statistic,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: Object.freeze({ startUtc: period.startUtc, endExclusiveUtc: period.endExclusiveUtc }),
    overall: summarize(counted),
    queues: valuesByQueueGroup(counted, summarize),
    counted: Object.freeze(counted),
    population: untaggedPopulation(population),
  });
}
