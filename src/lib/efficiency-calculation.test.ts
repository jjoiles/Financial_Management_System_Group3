import { describe, expect, it } from "vitest";
import { assertValidPeriod, valuesByQueueGroup } from "./efficiency-calculation";
import { RECOGNIZED_QUEUE_IDS } from "./efficiency-population";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function monthPeriod(key: string): PeriodBounds {
  const period = getCalendarMonthPeriod(key);
  if (!period) throw new Error(`no calendar month ${key}`);
  return period;
}

/** November 2026, UTC: [2026-11-01T00:00Z, 2026-12-01T00:00Z). */
const NOVEMBER = monthPeriod("2026-11");

const period = (startUtc: string, endExclusiveUtc: string): PeriodBounds => ({
  startUtc,
  endExclusiveUtc,
});

/** The fields valuesByQueueGroup reads (queue_id), plus an id to follow each stage. */
type Stage = { readonly id: string; readonly queue_id: string };
const stage = (id: string, queue_id: string): Stage => ({ id, queue_id });

const ids = (stages: readonly Stage[]) => stages.map((s) => s.id);

// ---------------------------------------------------------------------------
// assertValidPeriod
// ---------------------------------------------------------------------------

describe("assertValidPeriod", () => {
  it("accepts a real F18 period", () => {
    expect(() => assertValidPeriod("Test Metric", NOVEMBER)).not.toThrow();
  });

  it("accepts a period one millisecond long", () => {
    expect(() =>
      assertValidPeriod(
        "Test Metric",
        period("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.001Z"),
      ),
    ).not.toThrow();
  });

  it.each([
    ["not an instant", "not-a-date", NOVEMBER.endExclusiveUtc],
    ["date-only", "2026-11-01", NOVEMBER.endExclusiveUtc],
    ["without an offset", "2026-11-01T00:00:00", NOVEMBER.endExclusiveUtc],
    ["empty", "", NOVEMBER.endExclusiveUtc],
  ])("rejects a start bound that is %s", (_label, startUtc, endExclusiveUtc) => {
    expect(() => assertValidPeriod("Test Metric", period(startUtc, endExclusiveUtc))).toThrow(
      new RangeError("Test Metric: the period bounds must be valid instants."),
    );
  });

  it.each([
    ["not an instant", NOVEMBER.startUtc, "not-a-date"],
    ["date-only", NOVEMBER.startUtc, "2026-12-01"],
    ["an impossible date", NOVEMBER.startUtc, "2026-02-30T00:00:00Z"],
  ])("rejects an end bound that is %s", (_label, startUtc, endExclusiveUtc) => {
    expect(() => assertValidPeriod("Test Metric", period(startUtc, endExclusiveUtc))).toThrow(
      new RangeError("Test Metric: the period bounds must be valid instants."),
    );
  });

  it("reports invalid instants before the ordering check", () => {
    expect(() => assertValidPeriod("Test Metric", period("not-a-date", "not-a-date"))).toThrow(
      "the period bounds must be valid instants.",
    );
  });

  it("rejects an empty period: end equal to start", () => {
    expect(() =>
      assertValidPeriod("Test Metric", period(NOVEMBER.startUtc, NOVEMBER.startUtc)),
    ).toThrow(new RangeError("Test Metric: the period end must be later than its start."));
  });

  it("rejects an end earlier than the start", () => {
    expect(() =>
      assertValidPeriod("Test Metric", period(NOVEMBER.endExclusiveUtc, NOVEMBER.startUtc)),
    ).toThrow(new RangeError("Test Metric: the period end must be later than its start."));
  });

  it("compares instants, not text: equal instants in different offsets are an empty period", () => {
    expect(() =>
      assertValidPeriod("Test Metric", period("2026-11-01T05:00:00+05:00", "2026-11-01T00:00:00Z")),
    ).toThrow("the period end must be later than its start.");
  });

  it("names the metric in the error", () => {
    expect(() =>
      assertValidPeriod("Queue Throughput", period("not-a-date", NOVEMBER.endExclusiveUtc)),
    ).toThrow(/^Queue Throughput: /);
  });
});

// ---------------------------------------------------------------------------
// valuesByQueueGroup
// ---------------------------------------------------------------------------

describe("valuesByQueueGroup", () => {
  const count = (stages: readonly Stage[]) => stages.length;

  it("has one value per recognized queue, in RECOGNIZED_QUEUE_IDS order", () => {
    const result = valuesByQueueGroup([stage("a", "dean_office")], count);
    expect(Object.keys(result.recognized)).toEqual([...RECOGNIZED_QUEUE_IDS]);
  });

  it("groups stages by queue, keeping input order within each group", () => {
    const stages = [
      stage("d1", "dean_office"),
      stage("b1", "department_budget"),
      stage("d2", "dean_office"),
      stage("c1", "cfo_office"),
      stage("b2", "department_budget"),
    ];
    const result = valuesByQueueGroup(stages, ids);

    expect(result.recognized.dean_office).toEqual(["d1", "d2"]);
    expect(result.recognized.department_budget).toEqual(["b1", "b2"]);
    expect(result.recognized.cfo_office).toEqual(["c1"]);
    expect(result.recognized.research_admin).toEqual([]);
    expect(result.recognized.provost_finance).toEqual([]);
    expect(result.recognized.sponsored_programs).toEqual([]);
  });

  it("omits the unknown group when no stage has an unrecognized queue", () => {
    const result = valuesByQueueGroup([stage("a", "dean_office"), stage("b", "cfo_office")], count);
    expect(result).not.toHaveProperty("unknown");
    expect(Object.keys(result)).toEqual(["recognized"]);
  });

  it("includes the unknown group, with its value, when it has stages", () => {
    const result = valuesByQueueGroup(
      [stage("a", "dean_office"), stage("x", "legacy_queue"), stage("y", "retired_office")],
      ids,
    );
    expect(Object.keys(result)).toEqual(["recognized", "unknown"]);
    expect(result.unknown).toEqual(["x", "y"]);
    expect(result.recognized.dean_office).toEqual(["a"]);
  });

  it("puts a stage in the unknown group, never a recognized queue, unless its queue_id matches exactly", () => {
    const stages = [
      stage("case", "Dean_Office"),
      stage("space", " dean_office"),
      stage("empty", ""),
      stage("inherited", "constructor"),
      stage("label", "Dean's Office"),
    ];
    const result = valuesByQueueGroup(stages, ids);

    expect(result.unknown).toEqual(["case", "space", "empty", "inherited", "label"]);
    for (const queueId of RECOGNIZED_QUEUE_IDS) expect(result.recognized[queueId]).toEqual([]);
  });

  it("gives every recognized queue the value of an empty group, and no unknown group, for no stages", () => {
    const result = valuesByQueueGroup([] as Stage[], count);
    expect(Object.keys(result)).toEqual(["recognized"]);
    for (const queueId of RECOGNIZED_QUEUE_IDS) expect(result.recognized[queueId]).toBe(0);
  });

  it("calls valueOf once per recognized queue, plus once for the unknown group only when populated", () => {
    const calls: string[][] = [];
    const record = (stages: readonly Stage[]) => {
      calls.push(ids(stages));
      return stages.length;
    };

    valuesByQueueGroup([stage("a", "dean_office")], record);
    expect(calls).toHaveLength(RECOGNIZED_QUEUE_IDS.length);

    calls.length = 0;
    valuesByQueueGroup([stage("a", "dean_office"), stage("x", "legacy_queue")], record);
    expect(calls).toHaveLength(RECOGNIZED_QUEUE_IDS.length + 1);
    expect(calls[calls.length - 1]).toEqual(["x"]);
  });

  it("counts every stage exactly once across the groups", () => {
    const stages = [
      stage("a", "dean_office"),
      stage("b", "legacy_queue"),
      stage("c", "cfo_office"),
      stage("d", "dean_office"),
    ];
    const result = valuesByQueueGroup(stages, count);
    const total =
      Object.values(result.recognized).reduce((sum, n) => sum + n, 0) + (result.unknown ?? 0);
    expect(total).toBe(stages.length);
  });

  it("passes the caller's own stage objects to valueOf", () => {
    const only = stage("a", "dean_office");
    let received: readonly Stage[] = [];
    valuesByQueueGroup([only], (stages) => {
      if (stages.length > 0) received = stages;
      return stages.length;
    });
    expect(received[0]).toBe(only);
  });

  it("returns frozen containers and does not modify the input", () => {
    const stages = [stage("a", "dean_office"), stage("x", "legacy_queue")];
    const snapshot = structuredClone(stages);
    const result = valuesByQueueGroup(stages, count);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recognized)).toBe(true);
    expect(stages).toEqual(snapshot);
    expect(Object.isFrozen(stages)).toBe(false);
  });
});
