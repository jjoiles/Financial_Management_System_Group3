import type { DatasetIntegrityResult, EfficiencyRequestRow } from "@/lib/efficiency-data";
import {
  assertValidPeriod,
  indexReadyTables,
  periodAnchorTest,
  untaggedPopulation,
  type MetricNotCalculated,
} from "@/lib/efficiency-calculation";
import {
  classifyMetricPopulation,
  gateMetricLoad,
  type PopulationResult,
} from "@/lib/efficiency-classification";
import { EFFICIENCY_METRICS_VERSION } from "@/lib/efficiency-metrics";
import type { PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.5: Request Volume.
 *
 * Volume(P) = |{ r in financial_requests : r.created_at in P }|, over the
 * catalog's request_volume population (EFFICIENCY_METRICS.request_volume).
 *
 * Pure and browser-safe: no I/O. Everything metric-specific comes from the
 * catalog through the shared F19.4 helpers:
 * - gateMetricLoad: required reads and blocking errors (requests only, so a
 *   failed stage read never blocks this metric);
 * - classifyMetricPopulation: scope and ordered exclusions
 *   (prototype_request, then invalid_created_at) and flags (none today);
 * - the catalog period anchor (financial_requests.created_at) and the F18
 *   half-open period test isWithinPeriod, through efficiency-calculation.
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog,
 * the shared calculation steps, the classification module and F18 types.
 * Nothing it imports may import it back.
 */

const METRIC_ID = "request_volume" as const;
const METRIC_NAME = "Request Volume";

/** A calculated Request Volume for one reporting period. */
export type RequestVolumeCalculated = {
  readonly status: "calculated";
  readonly metricId: "request_volume";
  /** The catalog version the value was calculated under; values are comparable only within one version. */
  readonly catalogVersion: string;
  /** The half-open reporting period P: startUtc <= created_at < endExclusiveUtc. */
  readonly period: PeriodBounds;
  /**
   * The number of included requests created in P, whatever their status.
   * 0 when none qualify (the catalog's emptyResult "zero"), never no-data.
   */
  readonly value: number;
  /** The requests counted in `value`: included, created in P, in input order. */
  readonly counted: readonly EfficiencyRequestRow[];
  /**
   * The population classified over the whole supplied dataset, not only P
   * (DATA_QUALITY_RULES 5): included and excluded requests, exclusion
   * counts in catalog order and flag counts.
   */
  readonly population: PopulationResult<EfficiencyRequestRow>;
};

/**
 * Request Volume for one period, or the load's outcome when it cannot be
 * calculated. "blocked" and "cancelled" are gateMetricLoad's own results,
 * passed through unchanged: never 0 and never no-data.
 */
export type RequestVolumeResult = MetricNotCalculated | RequestVolumeCalculated;

/**
 * Calculates Request Volume for `period` from an F19.3 load result.
 *
 * 1. The period must be valid F18 bounds; anything else is a programming
 *    error and throws a RangeError, so it can never become a silent 0.
 * 2. gateMetricLoad("request_volume"): a cancelled load returns
 *    "cancelled"; a failed, incomplete or field-missing request read returns
 *    "blocked" with its error details. A stage read is not required, so its
 *    failure does not block.
 * 3. The request rows are classified with the catalog population over the
 *    whole dataset, so data-quality counts do not depend on `period`. Each
 *    excluded request gets only its first failing condition.
 * 4. value = the included requests whose created_at (the catalog anchor)
 *    lies in `period`.
 *
 * `prototypeRequests` are browser-only requests. The caller MUST scope them
 * to the signed-in owner (AGENTS.md) before passing them; this function
 * cannot check ownership, because a request row carries no owner. They are
 * only ever counted under prototype_request, never in `value`.
 *
 * Throws if the request rows repeat an id: a complete F19.3 read cannot, so
 * the input did not come from a validated load (see indexDataset).
 *
 * Pure: does not modify the load, the period or the prototype requests; the
 * result holds the caller's row objects.
 */
export function calculateRequestVolume(input: {
  readonly load: DatasetIntegrityResult;
  readonly period: PeriodBounds;
  readonly prototypeRequests?: readonly EfficiencyRequestRow[];
}): RequestVolumeResult {
  const { load, period, prototypeRequests } = input;
  assertValidPeriod(METRIC_NAME, period);

  const gate = gateMetricLoad(METRIC_ID, load);
  if (gate.status !== "ready") return gate;

  // The stage table is not a required read, so the gate never supplies it.
  const index = indexReadyTables(METRIC_NAME, gate.tables);
  const { population } = classifyMetricPopulation(METRIC_ID, { index, prototypeRequests });
  if (population.subject !== "request") {
    throw new Error("Request Volume: the catalog population must be a request population.");
  }

  const inPeriod = periodAnchorTest(METRIC_NAME, METRIC_ID, "financial_requests", period);
  const counted = population.included.filter(inPeriod);

  return Object.freeze({
    status: "calculated",
    metricId: METRIC_ID,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: Object.freeze({ startUtc: period.startUtc, endExclusiveUtc: period.endExclusiveUtc }),
    value: counted.length,
    counted: Object.freeze(counted),
    population: untaggedPopulation(population),
  });
}
