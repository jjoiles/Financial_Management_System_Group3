import { isWithinPeriod } from "@/lib/reporting-periods";
import {
  INSTITUTION_TIME_ZONE,
  isValidLocalDate,
  isValidTimeZone,
  localDateRangeToUtcBounds,
  nextLocalDate,
  zonedLocalMidnightToUtc,
  type InstantInput,
  type LocalDateRange,
  type PeriodBounds,
} from "@/lib/time-zones";

/**
 * F18.4: Cross-period filtering and custom date ranges.
 *
 * Pure and browser-safe: no I/O. Library only; no UI, database or server-side
 * query uses it yet (see docs/F18_Cross_Period_Filtering.md).
 *
 * - validateCustomDateRange() turns untrusted start date, end date and time
 *   zone values into half-open UTC bounds, or returns stable error codes. It
 *   never throws for invalid input.
 * - filterByPeriod() keeps the rows whose instant falls inside any
 *   PeriodBounds: a fiscal period, calendar month, academic term or session,
 *   academic coverage, or a custom range. Standard periods and custom ranges
 *   share this one function and isWithinPeriod().
 *
 * Time zone policy
 * - The application uses CUSTOM_DATE_RANGE_TIME_ZONE (America/New_York, the
 *   institution's zone) for custom ranges. Users do not choose a zone, and
 *   the viewer's zone (resolveViewerTimeZone) is never used for filtering.
 * - validateCustomDateRange() still requires the zone explicitly, so callers
 *   cannot silently inherit a different one.
 *
 * Dependency direction: this module imports time-zones.ts and
 * reporting-periods.ts. Neither may import it back.
 */

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/**
 * The fixed zone for custom date ranges in the application: Howard's
 * institutional zone. A custom range is a range, not a reporting-period kind,
 * so it is deliberately not part of REPORTING_PERIOD_TIME_ZONES.
 */
export const CUSTOM_DATE_RANGE_TIME_ZONE = INSTITUTION_TIME_ZONE;

/** Untrusted input, e.g. from a form. Every value is checked. */
export interface CustomDateRangeInput {
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly timeZone?: unknown;
}

/**
 * A validated custom date range. `startDate` and `endDate` are inclusive local
 * dates in `timeZone`; `startUtc` and `endExclusiveUtc` are the half-open UTC
 * bounds (startUtc <= instant < endExclusiveUtc), as for every period.
 */
export interface CustomDateRange extends PeriodBounds, LocalDateRange {
  readonly kind: "custom";
  readonly timeZone: string;
  /** Stable identifier, e.g. "custom:2026-01-01..2026-03-31@America/New_York". */
  readonly key: string;
  /** Display text, e.g. "January 1, 2026 – March 31, 2026 (America/New_York)". */
  readonly label: string;
}

export const CUSTOM_DATE_RANGE_ERROR_CODES = [
  /** Missing, null, empty or whitespace-only. */
  "required",
  /** Present but not a string. */
  "not-a-string",
  /** A date that is not written as YYYY-MM-DD. */
  "invalid-format",
  /** YYYY-MM-DD, but not a real calendar date (e.g. 2026-02-30). */
  "invalid-date",
  /** A zone the runtime's Intl does not support. */
  "unsupported-time-zone",
  /** The start date is after the end date. */
  "start-after-end",
  /** A local midnight the range needs does not exist in the zone. */
  "nonexistent-local-midnight",
  /** 9999-12-31: the day after it cannot be written with a four-digit year. */
  "unsupported-end-date",
] as const;
export type CustomDateRangeErrorCode = (typeof CUSTOM_DATE_RANGE_ERROR_CODES)[number];

/** "range" is used for errors about both dates together (start-after-end). */
export type CustomDateRangeErrorField = "startDate" | "endDate" | "timeZone" | "range";

export interface CustomDateRangeError {
  readonly field: CustomDateRangeErrorField;
  readonly code: CustomDateRangeErrorCode;
  readonly message: string;
}

export type CustomDateRangeValidationResult =
  | { readonly ok: true; readonly range: CustomDateRange }
  | { readonly ok: false; readonly errors: readonly CustomDateRangeError[] };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LOCAL_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const FIELD_NAMES: Record<Exclude<CustomDateRangeErrorField, "range">, string> = {
  startDate: "Start date",
  endDate: "End date",
  timeZone: "Time zone",
};

function error(
  field: CustomDateRangeErrorField,
  code: CustomDateRangeErrorCode,
  message: string,
): CustomDateRangeError {
  return Object.freeze({ field, code, message });
}

/** Common checks for a required string. Returns the string, or null after recording an error. */
function readRequiredString(
  value: unknown,
  field: Exclude<CustomDateRangeErrorField, "range">,
  errors: CustomDateRangeError[],
): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    errors.push(error(field, "required", `${FIELD_NAMES[field]} is required.`));
    return null;
  }
  if (typeof value !== "string") {
    errors.push(error(field, "not-a-string", `${FIELD_NAMES[field]} must be text.`));
    return null;
  }
  return value;
}

function readLocalDate(
  value: unknown,
  field: "startDate" | "endDate",
  errors: CustomDateRangeError[],
): string | null {
  const text = readRequiredString(value, field, errors);
  if (text === null) return null;
  if (!LOCAL_DATE_FORMAT.test(text)) {
    errors.push(
      error(field, "invalid-format", `${FIELD_NAMES[field]} must use the YYYY-MM-DD format.`),
    );
    return null;
  }
  if (!isValidLocalDate(text)) {
    errors.push(error(field, "invalid-date", `${FIELD_NAMES[field]} ${text} is not a real date.`));
    return null;
  }
  return text;
}

function readTimeZone(value: unknown, errors: CustomDateRangeError[]): string | null {
  const text = readRequiredString(value, "timeZone", errors);
  if (text === null) return null;
  if (!isValidTimeZone(text)) {
    errors.push(
      error("timeZone", "unsupported-time-zone", `Time zone "${text}" is not supported.`),
    );
    return null;
  }
  return text;
}

/** Calls fn and reports whether it threw a RangeError; other errors propagate. */
function throwsRangeError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (caught) {
    if (caught instanceof RangeError) return true;
    throw caught;
  }
}

/**
 * Finds which input caused localDateRangeToUtcBounds() to throw, once every
 * field is known to be valid and the dates are in order. Only a missing local
 * midnight or the 9999-12-31 end date remain possible.
 */
function classifyConversionFailure(
  startDate: string,
  endDate: string,
  timeZone: string,
): CustomDateRangeError[] {
  const errors: CustomDateRangeError[] = [];
  if (throwsRangeError(() => zonedLocalMidnightToUtc(startDate, timeZone))) {
    errors.push(
      error(
        "startDate",
        "nonexistent-local-midnight",
        `Midnight at the start of ${startDate} does not exist in ${timeZone}.`,
      ),
    );
  }
  let dayAfterEnd: string;
  try {
    dayAfterEnd = nextLocalDate(endDate);
  } catch (caught) {
    if (!(caught instanceof RangeError)) throw caught;
    errors.push(error("endDate", "unsupported-end-date", `End date ${endDate} is not supported.`));
    return errors;
  }
  if (throwsRangeError(() => zonedLocalMidnightToUtc(dayAfterEnd, timeZone))) {
    errors.push(
      error(
        "endDate",
        "nonexistent-local-midnight",
        `Midnight at the end of ${endDate} (start of ${dayAfterEnd}) does not exist in ${timeZone}.`,
      ),
    );
  }
  return errors;
}

function formatLabelDate(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function buildLabel(startDate: string, endDate: string, timeZone: string): string {
  const dates =
    startDate === endDate
      ? formatLabelDate(startDate)
      : `${formatLabelDate(startDate)} – ${formatLabelDate(endDate)}`;
  return `${dates} (${timeZone})`;
}

/**
 * Validates an untrusted custom date range and converts it to half-open UTC
 * bounds with localDateRangeToUtcBounds(). Never throws for invalid input.
 *
 * - `startDate` and `endDate` must be strict YYYY-MM-DD real dates; both are
 *   inclusive local dates in `timeZone`. A single-day range is valid. Future
 *   dates are allowed and there is no maximum length.
 * - `timeZone` is required. The application passes CUSTOM_DATE_RANGE_TIME_ZONE;
 *   never pass resolveViewerTimeZone().
 * - Values are not trimmed or normalized. Whitespace-only values count as
 *   missing; dates with surrounding whitespace are "invalid-format".
 *
 * Errors for each field are collected together. "start-after-end" is checked
 * only when both dates are valid, and the conversion errors
 * ("nonexistent-local-midnight", "unsupported-end-date") only when every other
 * check passes.
 */
export function validateCustomDateRange(
  input: CustomDateRangeInput | null | undefined,
): CustomDateRangeValidationResult {
  const source: CustomDateRangeInput = typeof input === "object" && input !== null ? input : {};
  const errors: CustomDateRangeError[] = [];

  const startDate = readLocalDate(source.startDate, "startDate", errors);
  const endDate = readLocalDate(source.endDate, "endDate", errors);
  const timeZone = readTimeZone(source.timeZone, errors);

  if (startDate !== null && endDate !== null && startDate > endDate) {
    errors.push(
      error(
        "range",
        "start-after-end",
        `Start date ${startDate} must be on or before end date ${endDate}.`,
      ),
    );
  }
  if (startDate === null || endDate === null || timeZone === null || errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  let bounds: PeriodBounds;
  try {
    bounds = localDateRangeToUtcBounds({ startDate, endDate }, timeZone);
  } catch (caught) {
    if (!(caught instanceof RangeError)) throw caught;
    const conversionErrors = classifyConversionFailure(startDate, endDate, timeZone);
    // Every expected failure is classified above; anything else is a bug.
    if (conversionErrors.length === 0) throw caught;
    return Object.freeze({ ok: false, errors: Object.freeze(conversionErrors) });
  }

  const range: CustomDateRange = Object.freeze({
    kind: "custom",
    startDate,
    endDate,
    timeZone,
    startUtc: bounds.startUtc,
    endExclusiveUtc: bounds.endExclusiveUtc,
    key: `custom:${startDate}..${endDate}@${timeZone}`,
    label: buildLabel(startDate, endDate, timeZone),
  });
  return Object.freeze({ ok: true, range });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Reads the instant a row is filtered by. */
export type InstantAccessor<T> = (row: T) => InstantInput | null | undefined;

/**
 * Default accessor. `createdAt` may hold anything (rows come from external
 * data); values that cannot be an instant become null, so the row is excluded.
 */
function readCreatedAt(
  row: { readonly createdAt?: unknown } | null | undefined,
): InstantInput | null {
  const value = row == null ? null : row.createdAt;
  return value instanceof Date || typeof value === "number" || typeof value === "string"
    ? value
    : null;
}

/**
 * Returns the rows whose instant falls inside `bounds`
 * (startUtc <= instant < endExclusiveUtc), using isWithinPeriod().
 *
 * - `bounds` may be any PeriodBounds: fiscal, calendar-month and academic
 *   periods, academic coverage, or a CustomDateRange.
 * - By default each row's full `createdAt` timestamp is used. There is no
 *   fallback to the date-only `submittedAt`.
 * - Instants are parsed strictly (toValidInstant). Rows with a missing,
 *   invalid or date-only timestamp are excluded; they never throw.
 * - Keeps input order, never mutates `rows`, and always returns a new array.
 */
export function filterByPeriod<T extends { readonly createdAt?: unknown }>(
  rows: readonly T[],
  bounds: PeriodBounds,
): T[];
export function filterByPeriod<T>(
  rows: readonly T[],
  bounds: PeriodBounds,
  getInstant: InstantAccessor<T>,
): T[];
export function filterByPeriod<T>(
  rows: readonly T[],
  bounds: PeriodBounds,
  getInstant: InstantAccessor<T> = readCreatedAt as InstantAccessor<T>,
): T[] {
  return rows.filter((row) => isWithinPeriod(bounds, getInstant(row)));
}
