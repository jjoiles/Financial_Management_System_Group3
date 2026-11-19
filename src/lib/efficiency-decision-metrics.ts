import {
  assertValidPeriod,
  indexReadyTables,
  periodAnchorTest,
  untaggedPopulation,
  type MetricNotCalculated,
} from "@/lib/efficiency-calculation";
import {
  classifyMetricPopulation,
  decisionInstant,
  gateMetricLoad,
  type PopulationResult,
} from "@/lib/efficiency-classification";
import type { DatasetIntegrityResult, EfficiencyRequestRow } from "@/lib/efficiency-data";
import {
  EFFICIENCY_METRICS,
  EFFICIENCY_METRICS_VERSION,
  TRACKED_TERMINAL_POPULATION,
} from "@/lib/efficiency-metrics";
import { selectDecisiveStage } from "@/lib/efficiency-population";
import { average, hoursBetween, median, NO_DATA, type Statistic } from "@/lib/efficiency-stats";
import type { PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.7: the decision metrics, Request Turnaround Time (average and
 * median) and Approval Rate.
 *
 * Both are calculated over the catalog's TRACKED_TERMINAL_POPULATION and
 * assign a request to the period containing its decision instant T(r): the
 * completed_at of its decisive stage, the stage with the highest
 * (workflow_revision, stage_order). created_at never decides the period.
 *
 * Pure and browser-safe: no I/O. Everything metric-specific comes from the
 * catalog through the shared F19.4 helpers:
 * - gateMetricLoad: both reads are required, so a failed, incomplete or
 *   field-missing read, or stage_request_not_loaded, blocks;
 * - classifyMetricPopulation: scope (approved, rejected or completed) and
 *   the seven ordered exclusions, ending with terminal_stage_invalid and
 *   decision_before_creation;
 * - selectDecisiveStage and decisionInstant: the decisive stage and T(r);
 * - the catalog statistic and period anchor.
 *
 * Distinct from the dashboard approvalRate in analytics-utils.ts, which this
 * module does not use.
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog,
 * the shared calculation steps, classification, the dataset helpers, the
 * stats helpers and F18 types. Nothing it imports may import it back.
 */

type DecisionMetricId =
  | "request_turnaround_time_average"
  | "request_turnaround_time_median"
  | "approval_rate";

export type RequestTurnaroundTimeMetricId =
  | "request_turnaround_time_average"
  | "request_turnaround_time_median";

/** The fields every calculated decision metric reports. */
type DecisionMetricBase<M extends DecisionMetricId> = {
  readonly status: "calculated";
  readonly metricId: M;
  /** The catalog version the value was calculated under; values are comparable only within one version. */
  readonly catalogVersion: string;
  /** The half-open reporting period P: startUtc <= T(r) < endExclusiveUtc. */
  readonly period: PeriodBounds;
  /** The tracked terminal requests decided in P (T(r) in P), in input order. */
  readonly counted: readonly EfficiencyRequestRow[];
  /**
   * The tracked terminal population classified over the whole supplied
   * dataset, not only P (DATA_QUALITY_RULES 5). Turnaround and approval rate
   * share it.
   */
  readonly population: PopulationResult<EfficiencyRequestRow>;
};

/** A calculated Request Turnaround Time for one reporting period. */
export type RequestTurnaroundTimeCalculated = DecisionMetricBase<RequestTurnaroundTimeMetricId> & {
  /** The catalog statistic of `metricId`. */
  readonly statistic: "average" | "median";
  /** The number of turnaround durations: counted.length. */
  readonly n: number;
  /** In hours; no-data when n = 0, never 0. */
  readonly value: Statistic;
};

/** A calculated Approval Rate for one reporting period. */
export type ApprovalRateCalculated = DecisionMetricBase<"approval_rate"> & {
  /** A: counted requests with status approved. */
  readonly approved: number;
  /** R: counted requests with status rejected. */
  readonly rejected: number;
  /** A / (A + R) as a fraction from 0 to 1; no-data when A + R = 0, never 0. */
  readonly value: Statistic;
};

export type RequestTurnaroundTimeResult = MetricNotCalculated | RequestTurnaroundTimeCalculated;
export type ApprovalRateResult = MetricNotCalculated | ApprovalRateCalculated;

type DecisionMetricInput = {
  readonly load: DatasetIntegrityResult;
  readonly period: PeriodBounds;
  /**
   * Browser-only prototype requests. The caller MUST scope them to the
   * signed-in owner (AGENTS.md); this module cannot check ownership. They are
   * only ever counted under prototype_request.
   */
  readonly prototypeRequests?: readonly EfficiencyRequestRow[];
};

/** An included request decided in the period, with its decision instant T(r). */
type DecidedRequest = { readonly request: EfficiencyRequestRow; readonly decidedAt: Date };

type Decided =
  | MetricNotCalculated
  | {
      readonly status: "decided";
      readonly population: PopulationResult<EfficiencyRequestRow>;
      readonly decided: readonly DecidedRequest[];
    };

/**
 * The steps both decision metrics share: validate the period, gate the load,
 * classify the tracked terminal population over the whole dataset, and keep
 * the included requests whose decisive stage's completed_at (the catalog
 * anchor, T(r)) lies in the period.
 */
function decidedInPeriod(
  metricId: DecisionMetricId,
  metricName: string,
  input: DecisionMetricInput,
): Decided {
  const { load, period, prototypeRequests } = input;
  assertValidPeriod(metricName, period);
  if (EFFICIENCY_METRICS[metricId].population !== TRACKED_TERMINAL_POPULATION) {
    throw new Error(`${metricName}: ${metricId} must use the tracked terminal population.`);
  }

  const gate = gateMetricLoad(metricId, load);
  if (gate.status !== "ready") return gate;

  const index = indexReadyTables(metricName, gate.tables);
  const { population } = classifyMetricPopulation(metricId, { index, prototypeRequests });
  if (population.subject !== "request") {
    throw new Error(`${metricName}: the catalog population must be a request population.`);
  }

  const inPeriod = periodAnchorTest(metricName, metricId, "approval_stage_tracking", period);
  const decided: DecidedRequest[] = [];
  for (const request of population.included) {
    // An included request passed terminal_stage_invalid, so it has a unique,
    // completed decisive stage with a valid completed_at.
    const stages = index.stagesByRequestId.get(request.id) ?? [];
    const decisive = selectDecisiveStage(stages);
    const decidedAt = decisionInstant(stages);
    if (decisive.status !== "decisive" || !decidedAt) {
      throw new Error(`${metricName}: included request ${request.id} has no decision instant.`);
    }
    if (inPeriod(decisive.stage)) decided.push(Object.freeze({ request, decidedAt }));
  }

  return {
    status: "decided",
    population: untaggedPopulation(population),
    decided,
  };
}

const frozenPeriod = (period: PeriodBounds): PeriodBounds =>
  Object.freeze({ startUtc: period.startUtc, endExclusiveUtc: period.endExclusiveUtc });

/** TAT(r) = (T(r) - created_at) / 3,600,000 ms. The population guarantees it is valid. */
function turnaroundHours({ request, decidedAt }: DecidedRequest, metricName: string): number {
  const elapsed = hoursBetween(request.created_at, decidedAt);
  if (!elapsed.ok) {
    throw new Error(
      `${metricName}: included request ${request.id} has no valid turnaround (${elapsed.reason}).`,
    );
  }
  return elapsed.hours;
}

/**
 * Calculates average or median Request Turnaround Time for `period`.
 *
 * Each tracked terminal request decided in `period` contributes
 * (T(r) - created_at) in hours. created_at is the request's original
 * creation time, so an amended request's turnaround includes its earlier
 * workflow revisions. A request created before the period counts when it was
 * decided in it; one created in the period but decided later does not.
 *
 * "cancelled" and "blocked" are gateMetricLoad's own results. An empty
 * population is no-data, never 0. Throws a RangeError for invalid period
 * bounds and an Error if ids repeat (not a validated F19.3 load). Pure.
 */
export function calculateRequestTurnaroundTime(
  metricId: RequestTurnaroundTimeMetricId,
  input: DecisionMetricInput,
): RequestTurnaroundTimeResult {
  const metricName = "Request Turnaround Time";
  const metric = EFFICIENCY_METRICS[metricId];
  if (metric.family !== "request_turnaround_time") {
    throw new Error(`${metricName}: ${metricId} is not a request turnaround time metric.`);
  }
  const { statistic } = metric;
  if (statistic !== "average" && statistic !== "median") {
    throw new Error(`${metricName}: unsupported catalog statistic "${statistic}".`);
  }

  const result = decidedInPeriod(metricId, metricName, input);
  if (result.status !== "decided") return result;

  const hours = result.decided.map((decided) => turnaroundHours(decided, metricName));
  return Object.freeze({
    status: "calculated",
    metricId,
    statistic,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: frozenPeriod(input.period),
    n: hours.length,
    value: statistic === "average" ? average(hours) : median(hours),
    counted: Object.freeze(result.decided.map(({ request }) => request)),
    population: result.population,
  });
}

/**
 * Calculates Approval Rate for `period`: A / (A + R), where A and R count
 * the tracked terminal requests decided in `period` with status approved and
 * rejected. A completed request never reaches the count: the population
 * excludes it under completed_status.
 *
 * The value is a fraction from 0 to 1 (catalog unit "ratio"); no-data when
 * A + R = 0, never 0. "cancelled" and "blocked" are gateMetricLoad's own
 * results. Throws a RangeError for invalid period bounds and an Error if ids
 * repeat. Pure.
 */
export function calculateApprovalRate(input: DecisionMetricInput): ApprovalRateResult {
  const metricId = "approval_rate";
  const metricName = "Approval Rate";
  const result = decidedInPeriod(metricId, metricName, input);
  if (result.status !== "decided") return result;

  let approved = 0;
  let rejected = 0;
  for (const { request } of result.decided) {
    if (request.status === "approved") approved += 1;
    else if (request.status === "rejected") rejected += 1;
    else {
      throw new Error(`${metricName}: included request ${request.id} is not approved or rejected.`);
    }
  }
  const decisions = approved + rejected;

  return Object.freeze({
    status: "calculated",
    metricId,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    period: frozenPeriod(input.period),
    approved,
    rejected,
    value:
      decisions === 0
        ? NO_DATA
        : Object.freeze({ kind: "value" as const, value: approved / decisions }),
    counted: Object.freeze(result.decided.map(({ request }) => request)),
    population: result.population,
  });
}
