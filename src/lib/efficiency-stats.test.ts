import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as statsModule from "./efficiency-stats";
import {
  MS_PER_HOUR,
  NO_DATA,
  average,
  hoursBetween,
  median,
  type HoursBetweenResult,
  type Statistic,
} from "./efficiency-stats";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The hours of a successful result, or a test failure. */
function hoursOf(result: HoursBetweenResult): number {
  if (!result.ok) throw new Error(`expected hours, got ${result.reason}`);
  return result.hours;
}

/** The value of a statistic, or a test failure. */
function valueOf(result: Statistic): number {
  if (result.kind !== "value") throw new Error("expected a value, got no-data");
  return result.value;
}

describe("hoursBetween", () => {
  it("uses calendar hours of 3,600,000 ms", () => {
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(hoursBetween("2026-11-02T13:00:00Z", "2026-11-04T13:00:00Z")).toEqual({
      ok: true,
      hours: 48,
    });
  });

  it("returns 0 for identical instants, including the same instant in different offsets", () => {
    expect(hoursBetween("2026-11-18T12:00:00Z", "2026-11-18T12:00:00Z")).toEqual({
      ok: true,
      hours: 0,
    });
    expect(hoursOf(hoursBetween("2026-11-18T12:00:00Z", "2026-11-18T07:00:00-05:00"))).toBe(0);
  });

  it("keeps fractional hours", () => {
    expect(hoursOf(hoursBetween("2026-11-02T12:58:30Z", "2026-11-02T13:00:00Z"))).toBe(0.025);
    expect(hoursOf(hoursBetween("2026-11-18T12:00:00Z", "2026-11-18T12:00:00.001Z"))).toBe(
      1 / MS_PER_HOUR,
    );
    expect(hoursOf(hoursBetween("2026-11-10T08:59:00Z", "2026-11-10T21:00:00Z"))).toBeCloseTo(
      12.0167,
      4,
    );
  });

  it("reproduces the section 5 durations", () => {
    // 5.4: request A turnaround, and the amended request H in 5.8.
    expect(hoursOf(hoursBetween("2026-11-02T12:58:30Z", "2026-11-07T01:00:00Z"))).toBe(108.025);
    expect(hoursOf(hoursBetween("2026-11-03T09:00:00Z", "2026-11-06T21:00:00Z"))).toBe(84);
    // 5.3: stage D1 spans the October/November boundary.
    expect(hoursOf(hoursBetween("2026-10-30T12:00:00Z", "2026-11-01T12:00:00Z"))).toBe(48);
  });

  it("measures elapsed time, not wall-clock time, across a DST change", () => {
    // 1:30 am EDT and 1:30 am EST on 2026-11-01 are one hour apart.
    expect(hoursOf(hoursBetween("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"))).toBe(1);
    expect(hoursOf(hoursBetween("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00"))).toBe(
      25,
    );
  });

  it("accepts Supabase timestamps and drops sub-millisecond digits", () => {
    expect(
      hoursOf(hoursBetween("2026-11-18T12:34:56.123456+00:00", "2026-11-18T13:34:56.123456+00:00")),
    ).toBe(1);
    // .000400 and .000900 both truncate to .000.
    expect(
      hoursOf(hoursBetween("2026-11-18T12:00:00.000400+00:00", "2026-11-18T12:00:00.000900+00:00")),
    ).toBe(0);
  });

  it("accepts Date objects and epoch milliseconds, like toValidInstant", () => {
    const start = new Date("2026-11-18T00:00:00Z");
    expect(hoursOf(hoursBetween(start, start.getTime() + 90 * 60_000))).toBe(1.5);
  });

  it("reports a reversed interval instead of a negative duration", () => {
    expect(hoursBetween("2026-11-20T00:00:00Z", "2026-11-19T00:00:00Z")).toEqual({
      ok: false,
      reason: "end-before-start",
    });
    expect(hoursBetween("2026-11-18T12:00:00.001Z", "2026-11-18T12:00:00Z")).toEqual({
      ok: false,
      reason: "end-before-start",
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["date-only", "2026-11-18"],
    ["no offset", "2026-11-18T12:00:00"],
    ["impossible date", "2026-02-30T12:00:00Z"],
    ["hour 24", "2026-11-18T24:00:00Z"],
    ["free text", "yesterday"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["invalid Date", new Date("not a date")],
  ])("rejects an invalid %s instant on either side", (_label, invalid) => {
    const valid = "2026-11-18T12:00:00Z";
    expect(hoursBetween(invalid, valid)).toEqual({ ok: false, reason: "invalid-start" });
    expect(hoursBetween(valid, invalid)).toEqual({ ok: false, reason: "invalid-end" });
  });

  it("reports the start first when both instants are invalid", () => {
    expect(hoursBetween(null, "not a timestamp")).toEqual({ ok: false, reason: "invalid-start" });
  });

  it("never returns NaN or Infinity, even at the limits of Date", () => {
    const result = hoursBetween(-8.64e15, 8.64e15);
    expect(Number.isFinite(hoursOf(result))).toBe(true);
    expect(hoursOf(result)).toBe((2 * 8.64e15) / MS_PER_HOUR);
  });

  it("returns frozen results and does not modify a Date argument", () => {
    const start = new Date("2026-11-18T00:00:00Z");
    const result = hoursBetween(start, "2026-11-18T01:00:00Z");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(hoursBetween(null, null))).toBe(true);
    expect(start.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });
});

describe("average", () => {
  it("returns no-data for no values, never 0", () => {
    expect(average([])).toBe(NO_DATA);
    expect(average([])).toEqual({ kind: "no-data" });
    expect(average([])).not.toEqual({ kind: "value", value: 0 });
  });

  it("returns the value itself for a single value, including 0", () => {
    expect(average([42.5])).toEqual({ kind: "value", value: 42.5 });
    expect(average([0])).toEqual({ kind: "value", value: 0 });
  });

  it("computes the arithmetic mean of the section 5.3 and 5.4 values", () => {
    expect(valueOf(average([48, 12, 48]))).toBe(36);
    expect(valueOf(average([12, 48, 48, 60]))).toBe(42);
    expect(valueOf(average([12, 24, 48, 48, 60]))).toBe(38.4);
    expect(valueOf(average([108.025, 12 + 1 / 60, 48 + 1 / 60]))).toBeCloseTo(56.0194, 4);
  });

  it("pools values rather than averaging group averages", () => {
    const groupA = [48, 12, 48];
    const groupB = [60];
    const pooled = valueOf(average([...groupA, ...groupB]));
    const ofAverages = valueOf(average([valueOf(average(groupA)), valueOf(average(groupB))]));
    expect(pooled).toBe(42);
    expect(ofAverages).toBe(48);
  });

  it("keeps decimal precision and allows negative values", () => {
    expect(valueOf(average([0.1, 0.2]))).toBeCloseTo(0.15, 15);
    expect(valueOf(average([1.5, 2.25, 3.125]))).toBe(6.875 / 3);
    expect(valueOf(average([-2, 4]))).toBe(1);
    expect(valueOf(average([-1.5, -2.5]))).toBe(-2);
  });

  it("does not overflow to Infinity", () => {
    const max = Number.MAX_VALUE;
    expect(valueOf(average([max, max]))).toBe(max);
    // Σ(x / n) alone rounds past the largest double for three maximal values.
    expect(valueOf(average([max, max, max]))).toBe(max);
    // Mixed signs: the true mean is max / 2, not the largest value. The
    // fallback path may differ from it in the last binary digit.
    const mixed = valueOf(average([max, max, max, -max]));
    expect(Math.abs(mixed - max / 2) / (max / 2)).toBeLessThan(1e-15);
    expect(valueOf(average([-max, -max, -max]))).toBe(-max);
    for (const values of [[max, max, max], [-max, -max], Array<number>(1000).fill(max)]) {
      expect(Number.isFinite(valueOf(average(values)))).toBe(true);
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("throws a RangeError for %s instead of returning it", (_label, bad) => {
    expect(() => average([1, bad, 3])).toThrow(RangeError);
    expect(() => average([1, bad, 3])).toThrow("average: value at index 1 is not a finite number.");
  });

  it("throws a RangeError for a non-number that bypasses the type", () => {
    expect(() => average(["4" as unknown as number])).toThrow(RangeError);
    expect(() => average([null as unknown as number])).toThrow(RangeError);
  });

  it("does not modify the input, including a frozen array", () => {
    const values = Object.freeze([3, 1, 2]);
    expect(valueOf(average(values))).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });

  it("returns frozen results", () => {
    expect(Object.isFrozen(average([1]))).toBe(true);
    expect(Object.isFrozen(NO_DATA)).toBe(true);
  });
});

describe("median", () => {
  it("returns no-data for no values, never 0", () => {
    expect(median([])).toBe(NO_DATA);
    expect(median([])).not.toEqual({ kind: "value", value: 0 });
  });

  it("returns the value itself for a single value", () => {
    expect(median([7.25])).toEqual({ kind: "value", value: 7.25 });
  });

  it("takes the middle value for an odd count, sorting numerically", () => {
    expect(valueOf(median([48, 12, 48]))).toBe(48);
    expect(valueOf(median([3, 1, 2]))).toBe(2);
    // Numeric, not lexicographic: lexicographic order would put 100 before 9.
    expect(valueOf(median([100, 9, 10]))).toBe(10);
  });

  it("averages the two middle values for an even count", () => {
    expect(valueOf(median([12, 48, 48, 60]))).toBe(48);
    expect(valueOf(median([1, 2, 3, 4]))).toBe(2.5);
    expect(valueOf(median([4, 1]))).toBe(2.5);
  });

  it("reproduces the section 5.4 turnaround median", () => {
    const tat = [108.025, 12 + 1 / 60, 48 + 1 / 60];
    expect(valueOf(median(tat))).toBe(48 + 1 / 60);
    expect(valueOf(median(tat))).toBeCloseTo(48.02, 2);
  });

  it("handles decimals, negatives, duplicates and zero", () => {
    expect(valueOf(median([0.3, 0.1, 0.2]))).toBe(0.2);
    expect(valueOf(median([-5, -1, -3]))).toBe(-3);
    expect(valueOf(median([-2, 2]))).toBe(0);
    expect(valueOf(median([5, 5, 5, 5]))).toBe(5);
    expect(valueOf(median([0, 0]))).toBe(0);
  });

  it("does not overflow when the two middle values are very large", () => {
    const max = Number.MAX_VALUE;
    expect(valueOf(median([max, max]))).toBe(max);
    expect(valueOf(median([-max, max]))).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("throws a RangeError for %s instead of sorting it", (_label, bad) => {
    expect(() => median([bad, 2])).toThrow("median: value at index 0 is not a finite number.");
  });

  it("does not modify the input, including a frozen array", () => {
    const values = [5, 3, 9, 1];
    const frozen = Object.freeze([5, 3, 9, 1]);
    expect(valueOf(median(values))).toBe(4);
    expect(valueOf(median(frozen))).toBe(4);
    expect(values).toEqual([5, 3, 9, 1]);
    expect(frozen).toEqual([5, 3, 9, 1]);
  });

  it("returns frozen results", () => {
    expect(Object.isFrozen(median([1, 2]))).toBe(true);
  });
});

describe("module boundaries", () => {
  const importSpecifiers = (source: string) =>
    [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);

  it("imports only the F18 time utilities", () => {
    expect(importSpecifiers(read("./efficiency-stats.ts"))).toEqual(["@/lib/time-zones"]);
  });

  it("is not imported by the catalog, the F19.3 data layer or F18 modules", () => {
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-data-loader.ts",
      "./time-zones.ts",
      "./reporting-periods.ts",
      "./reporting-period-config.ts",
      "./date-range-filter.ts",
    ]) {
      expect(read(file)).not.toMatch(/efficiency-stats/);
    }
  });

  it("exports only the statistics and time helpers", () => {
    expect(Object.keys(statsModule).sort()).toEqual(
      ["MS_PER_HOUR", "NO_DATA", "average", "hoursBetween", "median"].sort(),
    );
  });
});
