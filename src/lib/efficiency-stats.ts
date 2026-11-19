import { toValidInstant, type InstantInput } from "@/lib/time-zones";

/**
 * F19.4.1: statistics and time helpers for the efficiency calculations.
 *
 * Pure and browser-safe: no I/O, no catalog, Supabase, React or loader
 * imports. These helpers know nothing about metrics, populations or
 * data-quality codes; F19.4 calculation code maps their results onto the
 * catalog's rules (docs/F19_Efficiency_Metrics.md sections 3.1 and 3.8).
 *
 * - Durations are calendar hours: elapsed milliseconds / 3,600,000, with no
 *   business-hours or holiday adjustment, kept at full precision.
 * - An empty statistic is no-data, never 0.
 * - Nothing here returns NaN or Infinity.
 *
 * Dependency direction: imports only time-zones.ts (F18), which must not
 * import this module back.
 */

/** Milliseconds per calendar hour (section 3.1). */
export const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Elapsed hours
// ---------------------------------------------------------------------------

/**
 * Why no duration could be computed:
 * - "invalid-start" / "invalid-end": the instant is missing or not valid under
 *   the F18 rules (toValidInstant).
 * - "end-before-start": both are valid but the end is earlier than the start.
 *
 * Callers map these onto data-quality codes, for example
 * invalid_stage_timestamps for a stage, or decision_before_creation when a
 * decision instant precedes created_at.
 */
export type HoursBetweenFailure = "invalid-start" | "invalid-end" | "end-before-start";

export type HoursBetweenResult =
  | { readonly ok: true; readonly hours: number }
  | { readonly ok: false; readonly reason: HoursBetweenFailure };

/**
 * Elapsed calendar hours from `start` to `end`: (end - start) / 3,600,000 ms.
 *
 * - Instants are parsed with toValidInstant: a valid Date, finite epoch
 *   milliseconds, or an ISO-8601 timestamp with "Z" or an explicit offset
 *   (such as Supabase's `2026-11-18T12:34:56.123456+00:00`). Date-only
 *   values, timestamps without an offset, null, undefined, NaN and Infinity
 *   are invalid.
 * - Precision is one millisecond: JavaScript dates drop sub-millisecond
 *   digits (they are truncated, not rounded).
 * - Identical instants give 0 hours; fractions of an hour are kept.
 * - A reversed interval is never a negative duration: it is reported as
 *   "end-before-start". When both instants are invalid, "invalid-start" is
 *   reported.
 *
 * Never throws for invalid input. The result is frozen.
 */
export function hoursBetween(
  start: InstantInput | null | undefined,
  end: InstantInput | null | undefined,
): HoursBetweenResult {
  const startInstant = toValidInstant(start);
  if (!startInstant) return Object.freeze({ ok: false, reason: "invalid-start" });
  const endInstant = toValidInstant(end);
  if (!endInstant) return Object.freeze({ ok: false, reason: "invalid-end" });

  const elapsedMs = endInstant.getTime() - startInstant.getTime();
  if (elapsedMs < 0) return Object.freeze({ ok: false, reason: "end-before-start" });
  return Object.freeze({ ok: true, hours: elapsedMs / MS_PER_HOUR });
}

// ---------------------------------------------------------------------------
// Average and median
// ---------------------------------------------------------------------------

/** The result of a statistic over no values: no-data, never 0 (section 3.8). */
export type NoData = { readonly kind: "no-data" };

export const NO_DATA: NoData = Object.freeze({ kind: "no-data" });

/** A statistic's value, or no-data when there were no values. */
export type Statistic = { readonly kind: "value"; readonly value: number } | NoData;

const statistic = (value: number): Statistic => Object.freeze({ kind: "value", value });

/**
 * Throws a RangeError for a value that is not a finite number. Values reach
 * these helpers from hoursBetween or from counts, so a non-finite value is a
 * programming error, never data to average.
 */
function assertFinite(values: readonly number[], name: string): void {
  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(`${name}: value at index ${index} is not a finite number.`);
    }
  });
}

/**
 * Arithmetic mean, Σx / n, at full precision.
 *
 * - No values: NO_DATA, never 0.
 * - Negative and decimal values are allowed; the helper does not know what
 *   the values measure.
 * - Throws a RangeError if any value is NaN, Infinity or not a number.
 * - Never overflows to Infinity. Only if Σx does not fit in a double, the
 *   mean is computed as 4 · Σ((x / 4) / n), whose partial sums stay below a
 *   quarter of the largest double, and is kept within [min, max] of the
 *   values, where the true mean always lies, to absorb the final rounding.
 * - Does not modify `values`.
 */
export function average(values: readonly number[]): Statistic {
  assertFinite(values, "average");
  const n = values.length;
  if (n === 0) return NO_DATA;
  const sum = values.reduce((total, value) => total + value, 0);
  if (Number.isFinite(sum)) return statistic(sum / n);
  let scaled = 0;
  let lowest = values[0];
  let highest = values[0];
  for (const value of values) {
    scaled += value / 4 / n;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  return statistic(Math.min(Math.max(scaled * 4, lowest), highest));
}

/**
 * The middle value of the values sorted in ascending numeric order; for an
 * even count, the mean of the two middle values.
 *
 * - No values: NO_DATA, never 0.
 * - Negative and decimal values are allowed.
 * - Throws a RangeError if any value is NaN, Infinity or not a number.
 * - Sorts a copy, so `values` (including a frozen array) is not modified.
 */
export function median(values: readonly number[]): Statistic {
  assertFinite(values, "median");
  const n = values.length;
  if (n === 0) return NO_DATA;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(n / 2);
  if (n % 2 === 1) return statistic(sorted[middle]);
  // Halving first cannot overflow. Halving a normal double is exact, so this
  // equals (a + b) / 2 whenever that sum is finite and not subnormal.
  return statistic(sorted[middle - 1] / 2 + sorted[middle] / 2);
}
