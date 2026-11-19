import type { EfficiencyRequestRow, EfficiencyStageRow } from "@/lib/efficiency-data";
import type {
  MetricLoadGate,
  MetricTables,
  PopulationResult,
} from "@/lib/efficiency-classification";
import {
  EFFICIENCY_METRICS,
  type EfficiencyMetricId,
  type SourceTable,
} from "@/lib/efficiency-metrics";
import {
  groupStagesByQueue,
  indexDataset,
  type DatasetIndex,
  type QueueableStage,
} from "@/lib/efficiency-population";
import type { QueueId } from "@/lib/routing/rules";
import { isWithinPeriod } from "@/lib/reporting-periods";
import { toValidInstant, type InstantInput, type PeriodBounds } from "@/lib/time-zones";

/**
 * F19.4.5+: steps every F19.4 metric calculation shares.
 *
 * Pure and browser-safe. Holds no metric rules of its own: requirements,
 * populations and anchors come from the catalog through the F19.4 dataset
 * and classification modules. Metric modules import this; it imports none
 * of them.
 */

/** A load outcome that is not a value: gateMetricLoad's own "cancelled" or "blocked" result. */
export type MetricNotCalculated = Extract<
  MetricLoadGate,
  { readonly status: "cancelled" | "blocked" }
>;

/**
 * Throws a RangeError unless `period` is a valid, non-empty half-open
 * interval of strict instants. F18 builders never produce anything else, so
 * this is a programming error and must never become a silent 0 or no-data.
 */
export function assertValidPeriod(metricName: string, period: PeriodBounds): void {
  const start = toValidInstant(period.startUtc);
  const end = toValidInstant(period.endExclusiveUtc);
  if (!start || !end) {
    throw new RangeError(`${metricName}: the period bounds must be valid instants.`);
  }
  if (end.getTime() <= start.getTime()) {
    throw new RangeError(`${metricName}: the period end must be later than its start.`);
  }
}

/**
 * Indexes a ready gate's tables. A table the metric does not require is
 * absent from the gate and indexed as empty, so it is never used.
 *
 * Throws when ids repeat: a complete F19.3 read cannot contain duplicates, so
 * the input did not come from a validated load (see indexDataset).
 */
export function indexReadyTables(
  metricName: string,
  tables: MetricTables,
): DatasetIndex<EfficiencyRequestRow, EfficiencyStageRow> {
  const indexed = indexDataset({
    requests: tables.financial_requests?.rows ?? [],
    stages: tables.approval_stage_tracking?.rows ?? [],
  });
  if (indexed.status !== "indexed") {
    const repeated = [...indexed.duplicateRequestIds, ...indexed.duplicateStageIds];
    throw new Error(
      `${metricName}: ids repeat (${repeated.join(", ")}); the input is not a validated F19.3 load.`,
    );
  }
  return indexed.index;
}

type SourceRow = {
  readonly financial_requests: EfficiencyRequestRow;
  readonly approval_stage_tracking: EfficiencyStageRow;
};

const asInstantInput = (value: unknown): InstantInput | null =>
  typeof value === "string" || typeof value === "number" || value instanceof Date ? value : null;

/**
 * A test for "the record's catalog period anchor lies in `period`"
 * (F18 isWithinPeriod: startUtc <= instant < endExclusiveUtc).
 *
 * The anchor field is read from the catalog. Throws if the metric is not
 * period-assigned or its anchor is not a field of `table`'s rows.
 */
export function periodAnchorTest<T extends SourceTable>(
  metricName: string,
  metricId: EfficiencyMetricId,
  table: T,
  period: PeriodBounds,
): (row: SourceRow[T]) => boolean {
  const assignment = EFFICIENCY_METRICS[metricId].period;
  if (assignment.mode !== "period" || assignment.anchor.table !== table) {
    throw new Error(`${metricName}: the catalog anchor must be a ${table} field.`);
  }
  const field = assignment.anchor.field;
  return (row) =>
    isWithinPeriod(period, asInstantInput((row as Readonly<Record<string, unknown>>)[field]));
}

/**
 * A subject-tagged population as a plain PopulationResult, in a new frozen
 * object holding the same frozen lists and counts.
 */
export function untaggedPopulation<T>(
  population: { readonly subject: string } & PopulationResult<T>,
): PopulationResult<T> {
  return Object.freeze({
    inScope: population.inScope,
    included: population.included,
    excluded: population.excluded,
    exclusionCounts: population.exclusionCounts,
    flagged: population.flagged,
    flagCounts: population.flagCounts,
  });
}

/**
 * A per-queue output: every recognized queue, always present, in
 * RECOGNIZED_QUEUE_IDS order; and the unknown group, present only when it is
 * populated (at least one stage counted). A flagged unknown-queue stage is in
 * `unknown`, never in a recognized queue.
 */
export type QueueGroupValues<V> = {
  readonly recognized: Readonly<Record<QueueId, V>>;
  readonly unknown?: V;
};

/** Applies `valueOf` to each queue group of `stages` (groupStagesByQueue). */
export function valuesByQueueGroup<S extends QueueableStage, V>(
  stages: readonly S[],
  valueOf: (group: readonly S[]) => V,
): QueueGroupValues<V> {
  const groups = groupStagesByQueue(stages);
  const recognized = Object.freeze(
    Object.fromEntries(
      Object.entries(groups.recognized).map(([queueId, group]) => [queueId, valueOf(group)]),
    ) as Record<QueueId, V>,
  );
  return groups.unknown.length > 0
    ? Object.freeze({ recognized, unknown: valueOf(groups.unknown) })
    : Object.freeze({ recognized });
}
