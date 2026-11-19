/**
 * F18.3: Time zone handling.
 *
 * Pure and browser-safe: no I/O and no imports. This module must stay a leaf
 * of the import graph, so any module can use it without creating a cycle (see
 * docs/F18_Timezone_Handling.md).
 *
 * Policy
 * - Storage and comparison: instants are stored as UTC (Postgres TIMESTAMPTZ)
 *   and compared as epoch milliseconds. Nothing here changes that.
 * - Reporting-period boundaries: each period kind has a fixed zone, listed in
 *   REPORTING_PERIOD_TIME_ZONES in reporting-periods.ts. Academic periods use
 *   INSTITUTION_TIME_ZONE; fiscal periods and calendar months use UTC.
 * - Display: the viewer's zone (resolveViewerTimeZone) may change how an
 *   instant is shown, never which period or filter it belongs to.
 *
 * Every new function here takes an explicit time zone, so callers must say
 * which day boundary they mean. zonedLocalMidnightToUtc keeps its F18.1
 * default zone for compatibility.
 *
 * Error policy (same as F18.1)
 * - Invalid instants (bad data) return null.
 * - Invalid zones, invalid local dates and impossible ranges (programming or
 *   configuration errors) throw a RangeError.
 *
 * Local dates are `YYYY-MM-DD` strings with four-digit years. Instants follow
 * the strict input policy of toValidInstant.
 */

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/**
 * Howard University's reference time zone. Its academic calendar dates are
 * published as local dates in this zone.
 */
export const INSTITUTION_TIME_ZONE = "America/New_York" as const;

export const UTC_TIME_ZONE = "UTC" as const;

/** A Date, epoch milliseconds, or an ISO-8601 timestamp with "Z" or an explicit offset. */
export type InstantInput = Date | number | string;

/** Half-open interval: startUtc <= instant < endExclusiveUtc. ISO-8601 UTC strings. */
export interface PeriodBounds {
  readonly startUtc: string;
  readonly endExclusiveUtc: string;
}

export interface LocalDateRange {
  /** YYYY-MM-DD, inclusive. */
  readonly startDate: string;
  /** YYYY-MM-DD, inclusive. */
  readonly endDate: string;
}

/** Local dates are written with four-digit years. */
const MAX_LOCAL_DATE_YEAR = 9999;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const pad = (value: number, width: number) => String(value).padStart(width, "0");

// ---------------------------------------------------------------------------
// Local dates (moved unchanged from reporting-periods.ts)
// ---------------------------------------------------------------------------

/**
 * UTC midnight for a year, 0-based month and day. Unlike Date.UTC, this does
 * not map years 0–99 to 1900–1999, and out-of-range months and days roll over.
 */
export function utcMidnight(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function daysInMonth(year: number, month: number): number {
  return utcMidnight(year, month, 0).getUTCDate();
}

type LocalDateParts = { year: number; month: number; day: number };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(value: unknown): LocalDateParts | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function formatLocalDate({ year, month, day }: LocalDateParts): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidLocalDate(value: unknown): value is string {
  return parseLocalDate(value) !== null;
}

/** Returns the local date one day after `localDate` (YYYY-MM-DD). Not affected by DST. */
export function nextLocalDate(localDate: string): string {
  const parts = parseLocalDate(localDate);
  if (!parts) {
    throw new RangeError(`Invalid local date "${localDate}"; expected a real YYYY-MM-DD date`);
  }
  const next = utcMidnight(parts.year, parts.month - 1, parts.day + 1);
  if (next.getUTCFullYear() > MAX_LOCAL_DATE_YEAR) {
    throw new RangeError(`The day after "${localDate}" is outside the supported four-digit years`);
  }
  return formatLocalDate({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
}

// ---------------------------------------------------------------------------
// Instants (moved unchanged from reporting-periods.ts)
// ---------------------------------------------------------------------------

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function parseIsoInstant(value: string): Date | null {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", offsetHour = "0", offsetMinute = "0"] =
    match;
  if (!parseLocalDate(`${year}-${month}-${day}`)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Converts input to a valid instant, or returns null. Never falls back to the
 * current time. Always returns a new Date, so callers cannot mutate the input.
 *
 * Accepts a valid Date, finite epoch milliseconds, or a string matching
 * `YYYY-MM-DDTHH:mm[:ss[.fraction]]` plus `Z` or `±HH:mm` (fraction: 1–9
 * digits). The date and time parts must be real (no February 30, no hour 24).
 * Date-only strings and timestamps without an offset are rejected, because
 * JavaScript would parse them as UTC and host-local time respectively. See the
 * reporting-periods.ts header for the full list of rejected formats.
 */
export function toValidInstant(input: InstantInput | null | undefined): Date | null {
  let ms: number;
  if (input instanceof Date) {
    ms = input.getTime();
  } else if (typeof input === "number") {
    ms = new Date(input).getTime();
  } else if (typeof input === "string") {
    return parseIsoInstant(input);
  } else {
    return null;
  }
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// ---------------------------------------------------------------------------
// Time zone conversion (built-in Intl; no extra dependency)
// ---------------------------------------------------------------------------

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Throws a RangeError (from Intl) for a zone the runtime does not support. */
function getZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

type WallClock = LocalDateParts & { hour: number; minute: number; second: number };

function readWallClock(ms: number, timeZone: string): WallClock {
  const parts = getZoneFormatter(timeZone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** The zone's offset from UTC, in milliseconds, at the given instant. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const wall = readWallClock(ms, timeZone);
  const wallAsUtc =
    utcMidnight(wall.year, wall.month - 1, wall.day).getTime() +
    wall.hour * MS_PER_HOUR +
    wall.minute * MS_PER_MINUTE +
    wall.second * MS_PER_SECOND;
  return wallAsUtc - Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND;
}

/**
 * The UTC instant of local midnight at the start of `localDate` in `timeZone`.
 * For America/New_York this is 04:00Z during daylight time and 05:00Z otherwise.
 * Throws a RangeError for an invalid date or zone, or if that local midnight
 * does not exist in the zone (it always exists in America/New_York, where DST
 * changes at 02:00; it does not exist on some DST start days in zones such as
 * America/Santiago and America/Havana, which change at midnight).
 *
 * The default zone is kept for F18.1 compatibility; new code should pass one.
 */
export function zonedLocalMidnightToUtc(
  localDate: string,
  timeZone: string = INSTITUTION_TIME_ZONE,
): Date {
  const parts = parseLocalDate(localDate);
  if (!parts) {
    throw new RangeError(`Invalid local date "${localDate}"; expected a real YYYY-MM-DD date`);
  }
  const wallAsUtc = utcMidnight(parts.year, parts.month - 1, parts.day).getTime();
  // First guess with the offset at the wall time read as UTC, then correct once
  // in case a DST change lies between the guess and the real instant.
  let candidate = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  candidate = wallAsUtc - zoneOffsetMs(candidate, timeZone);

  const check = readWallClock(candidate, timeZone);
  if (
    check.year !== parts.year ||
    check.month !== parts.month ||
    check.day !== parts.day ||
    check.hour !== 0 ||
    check.minute !== 0 ||
    check.second !== 0
  ) {
    throw new RangeError(`Local midnight of ${localDate} does not exist in ${timeZone}`);
  }
  return new Date(candidate);
}

// ---------------------------------------------------------------------------
// F18.3 additions
// ---------------------------------------------------------------------------

/**
 * True when `value` is a non-empty string the runtime's Intl accepts as a time
 * zone. Never throws.
 *
 * Intl also accepts case variants ("america/new_york"), legacy links
 * ("US/Eastern") and fixed offsets ("+05:00"). Note that "EST" is a fixed
 * UTC-5 zone with no daylight saving time; use "America/New_York" for Eastern
 * time.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    getZoneFormatter(value);
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(timeZone: unknown): asserts timeZone is string {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid time zone ${JSON.stringify(timeZone)}`);
  }
}

/**
 * Instants this close to the four-digit year limits are not converted:
 * Intl.DateTimeFormat reports year 0 as year 1 (it hides the era), and no zone
 * offset reaches a full day, so one day of margin keeps every result correct.
 */
const EARLIEST_ZONED_DATE_MS = utcMidnight(1, 0, 2).getTime();
const LATEST_ZONED_DATE_MS = utcMidnight(MAX_LOCAL_DATE_YEAR, 11, 31).getTime();

/**
 * The local calendar date (YYYY-MM-DD) on which an instant falls in `timeZone`.
 * The inverse of zonedLocalMidnightToUtc: for every local date d,
 * toZonedLocalDate(zonedLocalMidnightToUtc(d, zone), zone) === d.
 *
 * Returns null for an invalid instant (see toValidInstant), or one within a
 * day of the year 0001–9999 limits. Throws a RangeError for an invalid zone.
 */
export function toZonedLocalDate(
  input: InstantInput | null | undefined,
  timeZone: string,
): string | null {
  assertTimeZone(timeZone);
  const instant = toValidInstant(input);
  if (!instant) return null;
  const ms = instant.getTime();
  if (ms < EARLIEST_ZONED_DATE_MS || ms >= LATEST_ZONED_DATE_MS) return null;
  const { year, month, day } = readWallClock(ms, timeZone);
  return formatLocalDate({ year, month, day });
}

/**
 * Today's local date (YYYY-MM-DD) in `timeZone`. The zone is required: use
 * INSTITUTION_TIME_ZONE for institutional days and UTC for UTC-based periods.
 *
 * Throws a RangeError for an invalid zone or an invalid `now`; it never falls
 * back to a different time.
 */
export function zonedToday(timeZone: string, now: Date | number = Date.now()): string {
  assertTimeZone(timeZone);
  const today = toZonedLocalDate(now, timeZone);
  if (today === null) {
    throw new RangeError(`Invalid current time ${String(now)}`);
  }
  return today;
}

/**
 * Converts an inclusive range of local dates in `timeZone` to half-open UTC
 * bounds: from local midnight at the start of `startDate` up to (excluding)
 * local midnight at the start of the day after `endDate`. Days on which DST
 * changes are 23 or 25 hours long, so the bounds follow the zone's offsets.
 *
 * The zone is required; there is deliberately no default.
 *
 * Throws a RangeError for an invalid zone, an invalid date, a start date after
 * the end date, an end date of 9999-12-31, or a local midnight that does not
 * exist in the zone.
 */
export function localDateRangeToUtcBounds(range: LocalDateRange, timeZone: string): PeriodBounds {
  assertTimeZone(timeZone);
  for (const date of [range.startDate, range.endDate]) {
    if (!isValidLocalDate(date)) {
      throw new RangeError(`Invalid local date "${date}"; expected a real YYYY-MM-DD date`);
    }
  }
  if (range.startDate > range.endDate) {
    throw new RangeError(
      `Start date ${range.startDate} must be on or before end date ${range.endDate}`,
    );
  }
  return {
    startUtc: zonedLocalMidnightToUtc(range.startDate, timeZone).toISOString(),
    endExclusiveUtc: zonedLocalMidnightToUtc(nextLocalDate(range.endDate), timeZone).toISOString(),
  };
}

/**
 * The viewer's time zone as reported by the runtime, or `fallback` when it is
 * missing or unsupported.
 *
 * DISPLAY ONLY. Never use the result to choose reporting-period or filter
 * boundaries; those come from REPORTING_PERIOD_TIME_ZONES. On the server
 * (e.g. Cloudflare Workers) the runtime zone is usually "UTC", so call this in
 * the browser.
 *
 * Throws a RangeError if `fallback` itself is not a valid zone.
 */
export function resolveViewerTimeZone(fallback: string = INSTITUTION_TIME_ZONE): string {
  assertTimeZone(fallback);
  let detected: unknown;
  try {
    detected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
  return isValidTimeZone(detected) ? detected : fallback;
}

export interface FormatInstantOptions {
  /** Zone to display the instant in. Required. */
  readonly timeZone: string;
  /** BCP 47 locale. Defaults to "en-US" so output never depends on the host. */
  readonly locale?: string;
  /** Include the hour and minute. Defaults to true. */
  readonly includeTime?: boolean;
  /** Include the short zone name, e.g. "EST" or "GMT+5:30". Defaults to true. */
  readonly includeTimeZoneName?: boolean;
}

/**
 * Formats an instant for display in an explicit zone, e.g.
 * "Nov 17, 2026, 8:00 PM EST". For display only; it has no effect on
 * filtering. Not yet used by any component.
 *
 * Returns null for an invalid instant (see toValidInstant). Throws a
 * RangeError for an invalid zone or locale.
 *
 * The exact characters (for example the space before AM/PM) come from the
 * runtime's ICU data and can differ between ICU versions.
 */
export function formatInstant(
  input: InstantInput | null | undefined,
  options: FormatInstantOptions,
): string | null {
  const { timeZone, locale = "en-US", includeTime = true, includeTimeZoneName = true } = options;
  assertTimeZone(timeZone);
  const instant = toValidInstant(input);
  if (!instant) return null;
  // dateStyle/timeStyle cannot be combined with timeZoneName, so the fields
  // are listed individually.
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
    ...(includeTimeZoneName ? { timeZoneName: "short" } : {}),
  }).format(instant);
}
