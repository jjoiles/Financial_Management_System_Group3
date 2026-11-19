import {
  indexReadyTables,
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
import type {
  DatasetIntegrityResult,
  EfficiencyRequestRow,
  EfficiencyStageRow,
  ReadWindow,
} from "@/lib/efficiency-data";
import { EFFICIENCY_METRICS, EFFICIENCY_METRICS_VERSION } from "@/lib/efficiency-metrics";

/**
 * F19.4.8: Active Queue Workload.
 *
 * Workload(q, now) = |{ distinct s.request_id : s.status = 'active',
 * s.queue_id = q, request(s).status in {submitted, under_review} }|, over the
 * catalog's active_queue_workload population.
 *
 * A snapshot of the loaded dataset, not a reporting-period metric: it takes
 * no period and uses no timestamp. The catalog groups it by queue only, so
 * there is no overall value: a request active in two queues is workload in
 * each, and the queues are not summed.
 *
 * Pure and browser-safe: no I/O. Everything metric-specific comes from the
 * catalog through the shared F19.4 helpers:
 * - gateMetricLoad: both reads are required, so a failed, incomplete or
 *   field-missing read, or stage_request_not_loaded, blocks;
 * - classifyMetricPopulation: scope (active stages), the orphaned_active_stage
 *   condition, the duplicate_active_stages (once per request) and
 *   unknown_queue (per stage) flags, and the pending_without_stage report.
 *
 * Dependency direction: imports the F19.3 types (type-only), the catalog,
 * the shared calculation steps and classification. Nothing it imports may
 * import it back.
 */

const METRIC_ID = "active_queue_workload" as const;
const METRIC_NAME = "Active Queue Workload";
const METRIC = EFFICIENCY_METRICS[METRIC_ID];

/** A separate report: its count and the population it was classified from. */
export type SeparateReportResult = {
  /** The report's records that passed every condition: population.included.length. */
  readonly count: number;
  /** Classified over the whole supplied dataset; excluded records keep their code. */
  readonly population: PopulationResult<EfficiencyRequestRow>;
};

/** A calculated Active Queue Workload snapshot. */
export type ActiveQueueWorkloadCalculated = {
  readonly status: "calculated";
  readonly metricId: "active_queue_workload";
  /** The catalog version the values were calculated under; values are comparable only within one version. */
  readonly catalogVersion: string;
  /**
   * When the snapshot was taken: the read interval of each table. The reads
   * are not atomic (non_atomic_reads), so the snapshot covers these
   * intervals, not a single instant.
   */
  readonly snapshot: {
    readonly financial_requests: ReadWindow;
    readonly approval_stage_tracking: ReadWindow;
  };
  /**
   * Distinct pending requests with an active stage, per recognized queue
   * (always present, 0 when none) and the unknown group (only when
   * populated). A request counts once in each queue where it has an active
   * stage, however many active stages it has there.
   */
  readonly queues: QueueGroupValues<number>;
  /** The active stages that make up the workload: included, in input order. */
  readonly counted: readonly EfficiencyStageRow[];
  /** The active-stage population: exclusions, flags and their counts. */
  readonly population: PopulationResult<EfficiencyStageRow>;
  /** The catalog's separate reports, keyed by code. Never part of the workload counts. */
  readonly separateReports: {
    /** Pending requests with no approval stage records of any status. */
    readonly pending_without_stage: SeparateReportResult;
  };
};

export type ActiveQueueWorkloadResult = MetricNotCalculated | ActiveQueueWorkloadCalculated;

const distinctRequests = (stages: readonly EfficiencyStageRow[]) =>
  new Set(stages.map((stage) => stage.request_id)).size;

/**
 * Calculates the Active Queue Workload snapshot from an F19.3 load result.
 *
 * 1. gateMetricLoad("active_queue_workload"): "cancelled" and "blocked" are
 *    returned unchanged, with every load error detail; never 0.
 * 2. Every supplied stage is classified with the catalog population: active
 *    stages are in scope, and one whose request is not pending is excluded as
 *    orphaned_active_stage. Included stages are flagged, never removed:
 *    duplicate_active_stages once per request, unknown_queue per stage.
 * 3. Each queue group's workload is its distinct request_id count.
 * 4. pending_without_stage is classified separately from the workload.
 *
 * `prototypeRequests` are browser-only requests. The caller MUST scope them
 * to the signed-in owner (AGENTS.md); this function cannot check ownership.
 * They have no stages, so they are never workload; in the separate report
 * they are counted only under prototype_request.
 *
 * Throws if ids repeat (not a validated F19.3 load). Pure: does not modify
 * the load or the prototype requests; the result holds the caller's rows.
 */
export function calculateActiveQueueWorkload(input: {
  readonly load: DatasetIntegrityResult;
  readonly prototypeRequests?: readonly EfficiencyRequestRow[];
}): ActiveQueueWorkloadResult {
  const { load, prototypeRequests } = input;
  if (METRIC.period.mode !== "snapshot") {
    throw new Error(`${METRIC_NAME}: the catalog must define a snapshot metric.`);
  }

  const gate = gateMetricLoad(METRIC_ID, load);
  if (gate.status !== "ready") return gate;
  const { financial_requests: requests, approval_stage_tracking: stages } = gate.tables;
  if (!requests || !stages) {
    throw new Error(`${METRIC_NAME}: a ready load must include both required tables.`);
  }

  const index = indexReadyTables(METRIC_NAME, gate.tables);
  const classification = classifyMetricPopulation(METRIC_ID, { index, prototypeRequests });
  const { population } = classification;
  const pending = classification.separateReports.pending_without_stage;
  if (population.subject !== "stage" || pending?.subject !== "request") {
    throw new Error(
      `${METRIC_NAME}: the catalog must define a stage population and a request pending_without_stage report.`,
    );
  }

  return Object.freeze({
    status: "calculated",
    metricId: METRIC_ID,
    catalogVersion: EFFICIENCY_METRICS_VERSION,
    snapshot: Object.freeze({
      financial_requests: requests.window,
      approval_stage_tracking: stages.window,
    }),
    queues: valuesByQueueGroup(population.included, distinctRequests),
    counted: population.included,
    population: untaggedPopulation(population),
    separateReports: Object.freeze({
      pending_without_stage: Object.freeze({
        count: pending.included.length,
        population: untaggedPopulation(pending),
      }),
    }),
  });
}
