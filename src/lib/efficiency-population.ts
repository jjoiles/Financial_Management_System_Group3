import type { EfficiencyRequestRow, EfficiencyStageRow } from "@/lib/efficiency-data";
import { UNKNOWN_QUEUE_GROUP } from "@/lib/efficiency-metrics";
import { QUEUES, type QueueId } from "@/lib/routing/rules";

/**
 * F19.4.2: dataset indexing, decisive-stage selection and queue groups.
 *
 * Pure and browser-safe. These are the dataset foundations the F19.4 metric
 * code builds on; load gating and population classification live in
 * efficiency-classification.ts. This module does not assign reporting
 * periods or calculate metric values.
 *
 * Records are never copied, changed or dropped: every helper returns the
 * caller's own row objects, in input order, inside new frozen containers.
 *
 * Dependency direction: imports the F19.3 row types (type-only), the
 * catalog's unknown-queue label and the routing QUEUES. Nothing it imports
 * may import it back, and it must not import efficiency-classification.ts,
 * which imports it.
 */

/** The request fields indexing needs. Any F19.3 request row satisfies it. */
export type IndexableRequest = Pick<EfficiencyRequestRow, "id">;

/** The stage fields indexing needs. Any F19.3 stage row satisfies it. */
export type IndexableStage = Pick<EfficiencyStageRow, "id" | "request_id">;

// ---------------------------------------------------------------------------
// Dataset indexing
// ---------------------------------------------------------------------------

export type DatasetIndex<R extends IndexableRequest, S extends IndexableStage> = {
  /** Every request, by id, in input order. */
  readonly requestsById: ReadonlyMap<string, R>;
  /** Every stage, in input order. */
  readonly stages: readonly S[];
  /**
   * Every stage, grouped by request_id in input order. Every request has an
   * entry, which is empty when it has no stages; stages whose request is not
   * in the dataset have entries too (see unmatchedStages).
   */
  readonly stagesByRequestId: ReadonlyMap<string, readonly S[]>;
  /**
   * Stages whose request_id matches no supplied request, in input order. They
   * are kept, not dropped: a stage-only metric reads stages without requests,
   * and metrics that need both tables are blocked earlier by the F19.3
   * load-integrity error stage_request_not_loaded.
   */
  readonly unmatchedStages: readonly S[];
};

/**
 * Indexing refuses input that repeats a request id or a stage id. A complete
 * F19.3 read cannot contain duplicates (readAllPages reports them as an
 * incomplete read), so a duplicate means the input did not come from a
 * validated dataset. Keeping one copy would hide that, and keeping both would
 * double count; neither is chosen.
 */
export type DatasetIndexResult<R extends IndexableRequest, S extends IndexableStage> =
  | { readonly status: "indexed"; readonly index: DatasetIndex<R, S> }
  | {
      readonly status: "duplicate-ids";
      /** Each id that appears more than once, once, in order of first repeat. */
      readonly duplicateRequestIds: readonly string[];
      readonly duplicateStageIds: readonly string[];
    };

/** Ids that occur more than once, each listed once, in order of first repeat. */
function repeatedIds(rows: readonly { readonly id: string }[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of rows) {
    if (seen.has(id)) repeated.add(id);
    else seen.add(id);
  }
  return [...repeated];
}

/**
 * Indexes requests by id and stages by request_id.
 *
 * - Pass an empty request array for a stage-only read; every stage is then
 *   unmatched.
 * - Fails with "duplicate-ids" when any request id or stage id repeats.
 * - Does not modify the inputs; the index holds the input row objects.
 */
export function indexDataset<R extends IndexableRequest, S extends IndexableStage>(input: {
  readonly requests: readonly R[];
  readonly stages: readonly S[];
}): DatasetIndexResult<R, S> {
  const duplicateRequestIds = repeatedIds(input.requests);
  const duplicateStageIds = repeatedIds(input.stages);
  if (duplicateRequestIds.length > 0 || duplicateStageIds.length > 0) {
    return Object.freeze({
      status: "duplicate-ids",
      duplicateRequestIds: Object.freeze(duplicateRequestIds),
      duplicateStageIds: Object.freeze(duplicateStageIds),
    });
  }

  const requestsById = new Map<string, R>();
  const grouped = new Map<string, S[]>();
  for (const request of input.requests) {
    requestsById.set(request.id, request);
    grouped.set(request.id, []);
  }

  const unmatchedStages: S[] = [];
  for (const stage of input.stages) {
    let group = grouped.get(stage.request_id);
    if (!group) {
      group = [];
      grouped.set(stage.request_id, group);
    }
    group.push(stage);
    if (!requestsById.has(stage.request_id)) unmatchedStages.push(stage);
  }

  const stagesByRequestId = new Map<string, readonly S[]>();
  for (const [requestId, stages] of grouped)
    stagesByRequestId.set(requestId, Object.freeze(stages));

  return Object.freeze({
    status: "indexed",
    index: Object.freeze({
      requestsById: requestsById as ReadonlyMap<string, R>,
      stages: Object.freeze([...input.stages]),
      stagesByRequestId: stagesByRequestId as ReadonlyMap<string, readonly S[]>,
      unmatchedStages: Object.freeze(unmatchedStages),
    }),
  });
}

// ---------------------------------------------------------------------------
// Decisive stage
// ---------------------------------------------------------------------------

/** The stage fields that order a request's stages (DECISIVE_STAGE_ORDERING). */
export type OrderableStage = Pick<EfficiencyStageRow, "workflow_revision" | "stage_order">;

export type DecisiveStageResult<S extends OrderableStage> =
  | { readonly status: "no-stages" }
  | { readonly status: "decisive"; readonly stage: S }
  | {
      readonly status: "invalid";
      /**
       * - "invalid-ordering-key": a stage's workflow_revision or stage_order is
       *   not a safe integer (null, a string, a fraction, NaN, ...), so the
       *   order cannot be known. `stages` are those stages.
       * - "tied-highest-pair": two or more stages share the highest
       *   (workflow_revision, stage_order). `stages` are the tied stages.
       */
      readonly reason: "invalid-ordering-key" | "tied-highest-pair";
      readonly stages: readonly S[];
    };

/**
 * A valid ordering key is a safe integer of type number. Strings are never
 * accepted, so keys are never compared as text; values beyond 2^53 are
 * rejected because they cannot be compared exactly.
 */
const isOrderingKey = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * Selects a request's decisive stage: the one with the highest
 * (workflow_revision, stage_order) pair, compared as integers, revision first
 * (revision 10 is newer than revision 9).
 *
 * - No stages: "no-stages".
 * - Any stage with an invalid ordering key, wherever it would sort: "invalid".
 * - Two or more stages sharing the highest pair: "invalid". A tie below the
 *   highest pair does not change which stage is decisive and is ignored.
 *
 * The stage's status is not considered here. Whether the decisive stage is
 * completed with a valid completed_at (condition 6, terminal_stage_invalid)
 * is decided by the population rules, and the caller should check
 * "no-stages" (untracked_terminal_request) first. Does not modify `stages`.
 */
export function selectDecisiveStage<S extends OrderableStage>(
  stages: readonly S[],
): DecisiveStageResult<S> {
  if (stages.length === 0) return Object.freeze({ status: "no-stages" });

  const invalid = stages.filter(
    (stage) => !isOrderingKey(stage.workflow_revision) || !isOrderingKey(stage.stage_order),
  );
  if (invalid.length > 0) {
    return Object.freeze({
      status: "invalid",
      reason: "invalid-ordering-key",
      stages: Object.freeze(invalid),
    });
  }

  let highest: S[] = [];
  for (const stage of stages) {
    const top = highest[0];
    const order = top
      ? stage.workflow_revision - top.workflow_revision || stage.stage_order - top.stage_order
      : 1;
    if (order > 0) highest = [stage];
    else if (order === 0) highest.push(stage);
  }

  if (highest.length > 1) {
    return Object.freeze({
      status: "invalid",
      reason: "tied-highest-pair",
      stages: Object.freeze(highest),
    });
  }
  return Object.freeze({ status: "decisive", stage: highest[0] });
}

// ---------------------------------------------------------------------------
// Queue groups
// ---------------------------------------------------------------------------

/** The recognized queues, in QUEUES order. Derived from routing, never listed here. */
export const RECOGNIZED_QUEUE_IDS: readonly QueueId[] = Object.freeze(
  Object.keys(QUEUES) as QueueId[],
);

/** A recognized queue, or the catalog's unknown group. */
export type QueueGroup = QueueId | typeof UNKNOWN_QUEUE_GROUP;

/**
 * True only for an exact, own QueueId key of QUEUES. Values are not trimmed
 * or case-folded, and inherited names such as "constructor" are not queues.
 */
export function isRecognizedQueueId(value: unknown): value is QueueId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(QUEUES, value);
}

/** The group a queue_id belongs to: itself when recognized, otherwise UNKNOWN_QUEUE_GROUP. */
export function toQueueGroup(queueId: unknown): QueueGroup {
  return isRecognizedQueueId(queueId) ? queueId : UNKNOWN_QUEUE_GROUP;
}

/** The stage field queue grouping needs. */
export type QueueableStage = Pick<EfficiencyStageRow, "queue_id">;

export type QueueGroups<S extends QueueableStage> = {
  /** Every recognized queue, in RECOGNIZED_QUEUE_IDS order; empty when it has no stages. */
  readonly recognized: Readonly<Record<QueueId, readonly S[]>>;
  /** Stages whose queue_id is not recognized, in input order, queue_id unchanged. */
  readonly unknown: readonly S[];
};

/**
 * Assigns each stage to its recognized queue or the unknown group. Every
 * input stage appears exactly once; nothing is dropped or modified.
 */
export function groupStagesByQueue<S extends QueueableStage>(stages: readonly S[]): QueueGroups<S> {
  const recognized = Object.fromEntries(
    RECOGNIZED_QUEUE_IDS.map((queueId) => [queueId, [] as S[]]),
  ) as Record<QueueId, S[]>;
  const unknown: S[] = [];

  for (const stage of stages) {
    const group = toQueueGroup(stage.queue_id);
    if (group === UNKNOWN_QUEUE_GROUP) unknown.push(stage);
    else recognized[group].push(stage);
  }

  for (const queueId of RECOGNIZED_QUEUE_IDS) Object.freeze(recognized[queueId]);
  return Object.freeze({
    recognized: Object.freeze(recognized),
    unknown: Object.freeze(unknown),
  });
}
