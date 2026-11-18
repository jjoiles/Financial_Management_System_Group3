import { z } from "zod";
import { HOWARD_ACADEMIC_CALENDAR } from "@/lib/howard-academic-calendar";
import { FISCAL_QUARTERS, deriveFiscalPeriod, type FiscalQuarter } from "@/lib/request-utils";

/**
 * F18.1: Institutional reporting periods.
 *
 * Defines three kinds of reporting period and what it means for a moment in
 * time to fall inside one. This module is pure and browser-safe: it does no
 * I/O and does not filter requests (that is later F18 work).
 *
 * Time zone policy
 * - Fiscal periods and calendar months use UTC boundaries. Fiscal periods
 *   come from deriveFiscalPeriod() in request-utils.ts, which matches the
 *   f4_enforce_request_metadata() SQL trigger.
 * - Academic periods use Howard's published calendar dates, which are local
 *   dates in Eastern time (America/New_York). Each boundary is local midnight
 *   converted to a UTC instant, so it moves between 04:00Z and 05:00Z with
 *   daylight saving time.
 * - The two policies differ on purpose. For example, 9 pm Eastern on
 *   August 31 is already September in UTC, so it is in the September
 *   calendar month while still being in August for the academic calendar.
 *
 * Interval policy
 * - Every period is half-open: startUtc <= instant < endExclusiveUtc. Adjacent
 *   periods share a boundary instant, and that instant belongs to the later one.
 *
 * Invalid input policy
 * - Invalid dates are never assigned to the current period. Lookups return
 *   null (or an empty list) and isWithinPeriod returns false.
 * - Accepted instants (see toValidInstant): a valid Date, finite epoch
 *   milliseconds, or an ISO-8601 timestamp string of the form
 *   `YYYY-MM-DDTHH:mm[:ss[.fraction]]` followed by `Z` or `±HH:mm`, e.g.
 *   "2026-11-18T12:34:56.123456+00:00" as returned by Supabase.
 * - Rejected strings: date-only strings ("2026-11-01") and timestamps
 *   without an offset, because JavaScript parses them as UTC and host-local
 *   time respectively, which would make results depend on the machine; the
 *   space-separated Postgres text form ("2026-11-01 00:00:00+00"); offsets
 *   without a colon ("+0000", "+00"); lowercase "z"; surrounding whitespace.
 *   Pass a request's full `createdAt`, not the date-only `submittedAt`.
 *
 * Errors
 * - Fiscal lookups throw an Error if the bounds found from
 *   deriveFiscalPeriod() fail their internal checks (the fiscal rule stopped
 *   changing at UTC month starts, or a period is not a continuous run of
 *   months). That means the shared fiscal rule changed in an unsupported way;
 *   it never happens for invalid input, which returns null instead.
 * - Academic lookups throw an Error if the calendar data fails
 *   validateAcademicCalendar().
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const REPORTING_PERIOD_KINDS = ["fiscal", "academic", "calendar-month"] as const;
export type ReportingPeriodKind = (typeof REPORTING_PERIOD_KINDS)[number];

/** Time zone in which Howard's academic calendar dates are published. */
export const ACADEMIC_TIME_ZONE = "America/New_York" as const;

export const ACADEMIC_TERMS = ["fall", "spring", "summer"] as const;
export type AcademicTerm = (typeof ACADEMIC_TERMS)[number];

export const SUMMER_SESSIONS = ["summer-1", "summer-2", "summer-10wk"] as const;
export type SummerSession = (typeof SUMMER_SESSIONS)[number];

/** Half-open interval: startUtc <= instant < endExclusiveUtc. ISO-8601 UTC strings. */
export interface PeriodBounds {
  readonly startUtc: string;
  readonly endExclusiveUtc: string;
}

interface BasePeriod extends PeriodBounds {
  readonly kind: ReportingPeriodKind;
  /** Stable machine-readable identifier, e.g. "FY2027-Q1", "AY2026-2027-FALL", "2026-11". */
  readonly key: string;
  /** Display text, e.g. "FY2027 Q1", "Fall 2026", "November 2026". */
  readonly label: string;
}

export interface FiscalYearPeriod extends BasePeriod {
  readonly kind: "fiscal";
  readonly granularity: "year";
  readonly fiscalYear: string;
}

export interface FiscalQuarterPeriod extends BasePeriod {
  readonly kind: "fiscal";
  readonly granularity: "quarter";
  readonly fiscalYear: string;
  readonly fiscalQuarter: FiscalQuarter;
  /** Key of the containing fiscal year. */
  readonly parentKey: string;
}

interface AcademicBasePeriod extends BasePeriod {
  readonly kind: "academic";
  /** e.g. "AY2026-2027". */
  readonly academicYear: string;
  readonly timeZone: typeof ACADEMIC_TIME_ZONE;
  /** Published local start date (YYYY-MM-DD), inclusive. */
  readonly localStartDate: string;
  /** Published local end date (YYYY-MM-DD), inclusive. */
  readonly localEndDate: string;
}

export interface AcademicTermPeriod extends AcademicBasePeriod {
  readonly granularity: "term";
  readonly term: AcademicTerm;
  /**
   * Keys of the sessions inside this term, in SUMMER_SESSIONS order
   * (Session I, Session II, 10-Week). Only Summer has sessions.
   */
  readonly sessionKeys: readonly string[];
}

export interface AcademicSessionPeriod extends AcademicBasePeriod {
  readonly granularity: "session";
  readonly term: "summer";
  readonly session: SummerSession;
  /** Key of the containing Summer term. */
  readonly parentKey: string;
}

export interface CalendarMonthPeriod extends BasePeriod {
  readonly kind: "calendar-month";
  readonly granularity: "month";
  readonly year: number;
  /** 1–12. */
  readonly month: number;
}

export type FiscalPeriod = FiscalYearPeriod | FiscalQuarterPeriod;
export type AcademicPeriod = AcademicTermPeriod | AcademicSessionPeriod;
export type ReportingPeriod = FiscalPeriod | AcademicPeriod | CalendarMonthPeriod;

/** A Date, epoch milliseconds, or an ISO-8601 timestamp with "Z" or an explicit offset. */
export type ReportingInstantInput = Date | number | string;

// Academic calendar input (published local dates) ---------------------------

export interface LocalDateRange {
  /** YYYY-MM-DD, inclusive. */
  readonly startDate: string;
  /** YYYY-MM-DD, inclusive. */
  readonly endDate: string;
}

export interface AcademicCalendarSource {
  readonly url: string;
  readonly publishedBy: string;
  /** YYYY-MM-DD the dates were verified against this source. */
  readonly retrievedOn: string;
}

export interface AcademicCalendarYear {
  /** "AY<start year>-<end year>", e.g. "AY2026-2027". */
  readonly academicYear: string;
  readonly sources: readonly AcademicCalendarSource[];
  readonly fall: LocalDateRange;
  readonly spring: LocalDateRange;
  readonly summer: {
    readonly sessions: Readonly<Record<SummerSession, LocalDateRange>>;
    /**
     * Official Summer semester start date, if published. Otherwise the
     * Summer term starts with its earliest session.
     */
    readonly startDate?: string;
    /**
     * Official Summer semester end date (e.g. "Summer Semester Ends"), if
     * published. Otherwise the Summer term ends with its latest session.
     * Each of startDate and endDate falls back independently.
     */
    readonly endDate?: string;
  };
}

export type AcademicCalendar = readonly AcademicCalendarYear[];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Four-digit years only, so every key has a fixed shape. */
const MIN_KEY_YEAR = 1000;
const MAX_KEY_YEAR = 9999;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

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

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/**
 * UTC midnight for a year, 0-based month and day. Unlike Date.UTC, this does
 * not map years 0–99 to 1900–1999, and out-of-range months and days roll over.
 */
function utcMidnight(year: number, monthIndex: number, day: number): Date {
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
  if (next.getUTCFullYear() > MAX_KEY_YEAR) {
    throw new RangeError(`The day after "${localDate}" is outside the supported four-digit years`);
  }
  return formatLocalDate({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
}

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
 * See the module header for the formats that are rejected and why.
 */
export function toValidInstant(input: ReportingInstantInput | null | undefined): Date | null {
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

/** True when `input` is a valid instant with startUtc <= instant < endExclusiveUtc. */
export function isWithinPeriod(
  period: PeriodBounds,
  input: ReportingInstantInput | null | undefined,
): boolean {
  const instant = toValidInstant(input);
  if (!instant) return false;
  const time = instant.getTime();
  return Date.parse(period.startUtc) <= time && time < Date.parse(period.endExclusiveUtc);
}

// ---------------------------------------------------------------------------
// Time zone conversion (built-in Intl; no extra dependency)
// ---------------------------------------------------------------------------

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

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
 * Throws a RangeError for an invalid date, or if that local midnight does not
 * exist in the zone (it always exists in America/New_York, where DST changes at 02:00).
 */
export function zonedLocalMidnightToUtc(
  localDate: string,
  timeZone: string = ACADEMIC_TIME_ZONE,
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
// Fiscal periods (reuse deriveFiscalPeriod as the single source of truth)
// ---------------------------------------------------------------------------

const FISCAL_YEAR_KEY_PATTERN = /^FY(\d{4})$/;

/** Calendar years scanned around a fiscal year's label year when finding its bounds. */
const FISCAL_SCAN_YEARS_BEFORE = 2;
const FISCAL_SCAN_YEARS_AFTER = 1;

const fiscalYearCache = new Map<string, FiscalYearPeriod | null>();
const fiscalQuarterCache = new Map<string, FiscalQuarterPeriod | null>();

type FiscalLabels = ReturnType<typeof deriveFiscalPeriod>;

/**
 * Finds the UTC bounds of the fiscal period whose labels satisfy `matches`, by
 * asking deriveFiscalPeriod() about each UTC month start around `labelYear`.
 * No fiscal start month is hardcoded here, so the bounds always follow the
 * existing rule. deriveFiscalPeriod() only reads the UTC month and year, so its
 * periods change only at UTC month starts; the invariant checks below fail
 * loudly if that ever stops being true.
 */
function findFiscalBounds(
  labelYear: number,
  matches: (labels: FiscalLabels) => boolean,
): { start: Date; endExclusive: Date } | null {
  const firstYear = labelYear - FISCAL_SCAN_YEARS_BEFORE;
  const monthCount = (FISCAL_SCAN_YEARS_BEFORE + 1 + FISCAL_SCAN_YEARS_AFTER) * 12;
  let first = -1;
  let last = -1;

  for (let index = 0; index < monthCount; index += 1) {
    if (!matches(deriveFiscalPeriod(utcMidnight(firstYear, index, 1)))) continue;
    if (first === -1) {
      first = index;
    } else if (last !== index - 1) {
      throw new Error(`Fiscal period around ${labelYear} is not a continuous run of months`);
    }
    last = index;
  }

  if (first === -1) return null;
  if (first === 0 || last === monthCount - 1) {
    throw new Error(`Fiscal period around ${labelYear} extends beyond the scanned months`);
  }

  const start = utcMidnight(firstYear, first, 1);
  const endExclusive = utcMidnight(firstYear, last + 1, 1);
  if (
    matches(deriveFiscalPeriod(new Date(start.getTime() - 1))) ||
    !matches(deriveFiscalPeriod(new Date(endExclusive.getTime() - 1)))
  ) {
    throw new Error(`Fiscal period around ${labelYear} does not change at UTC month starts`);
  }
  return { start, endExclusive };
}

/**
 * The fiscal year for a key such as "FY2027", or null if the key is malformed.
 * @throws Error if the bounds found from deriveFiscalPeriod() fail their
 * internal checks (see the module header); never for malformed input.
 */
export function getFiscalYearPeriod(fiscalYear: string): FiscalYearPeriod | null {
  const match = typeof fiscalYear === "string" ? FISCAL_YEAR_KEY_PATTERN.exec(fiscalYear) : null;
  if (!match) return null;
  const cached = fiscalYearCache.get(fiscalYear);
  if (cached !== undefined) return cached;

  const labelYear = Number(match[1]);
  const bounds = findFiscalBounds(labelYear, (labels) => labels.fiscalYear === fiscalYear);
  const period: FiscalYearPeriod | null = bounds
    ? Object.freeze({
        kind: "fiscal",
        granularity: "year",
        key: fiscalYear,
        label: `Fiscal Year ${labelYear}`,
        fiscalYear,
        startUtc: bounds.start.toISOString(),
        endExclusiveUtc: bounds.endExclusive.toISOString(),
      })
    : null;
  fiscalYearCache.set(fiscalYear, period);
  return period;
}

/**
 * A fiscal quarter such as ("FY2027", "Q1"), or null if either part is malformed.
 * @throws Error if the bounds found from deriveFiscalPeriod() fail their
 * internal checks (see the module header); never for malformed input.
 */
export function getFiscalQuarterPeriod(
  fiscalYear: string,
  fiscalQuarter: string,
): FiscalQuarterPeriod | null {
  const match = typeof fiscalYear === "string" ? FISCAL_YEAR_KEY_PATTERN.exec(fiscalYear) : null;
  if (!match || !(FISCAL_QUARTERS as readonly string[]).includes(fiscalQuarter)) return null;
  const quarter = fiscalQuarter as FiscalQuarter;
  const key = `${fiscalYear}-${quarter}`;
  const cached = fiscalQuarterCache.get(key);
  if (cached !== undefined) return cached;

  const bounds = findFiscalBounds(
    Number(match[1]),
    (labels) => labels.fiscalYear === fiscalYear && labels.fiscalQuarter === quarter,
  );
  const period: FiscalQuarterPeriod | null = bounds
    ? Object.freeze({
        kind: "fiscal",
        granularity: "quarter",
        key,
        label: `${fiscalYear} ${quarter}`,
        fiscalYear,
        fiscalQuarter: quarter,
        parentKey: fiscalYear,
        startUtc: bounds.start.toISOString(),
        endExclusiveUtc: bounds.endExclusive.toISOString(),
      })
    : null;
  fiscalQuarterCache.set(key, period);
  return period;
}

/**
 * The four quarters of a fiscal year, in fiscal order, or null if the key is malformed.
 * @throws Error under the same conditions as getFiscalQuarterPeriod().
 */
export function getFiscalQuartersForYear(
  fiscalYear: string,
): readonly FiscalQuarterPeriod[] | null {
  const quarters = FISCAL_QUARTERS.map((quarter) => getFiscalQuarterPeriod(fiscalYear, quarter));
  return quarters.every((quarter) => quarter !== null)
    ? Object.freeze(quarters as FiscalQuarterPeriod[])
    : null;
}

/**
 * The fiscal year and quarter containing an instant, or null for invalid
 * input. The input is checked before deriveFiscalPeriod() is called, because
 * that function silently uses the current date for an invalid Date.
 * Returns null for instants whose fiscal year label is not four digits.
 * @throws Error if the fiscal bounds fail their internal checks or do not
 * contain the instant, i.e. the shared fiscal rule changed in an unsupported
 * way (see the module header). Invalid input never throws.
 */
export function getFiscalPeriodsForDate(
  input: ReportingInstantInput | null | undefined,
): { readonly year: FiscalYearPeriod; readonly quarter: FiscalQuarterPeriod } | null {
  const instant = toValidInstant(input);
  if (!instant) return null;
  const { fiscalYear, fiscalQuarter } = deriveFiscalPeriod(instant);
  const year = getFiscalYearPeriod(fiscalYear);
  const quarter = getFiscalQuarterPeriod(fiscalYear, fiscalQuarter);
  // Only fiscal years with four-digit labels are supported.
  if (!year || !quarter) return null;
  if (!isWithinPeriod(year, instant) || !isWithinPeriod(quarter, instant)) {
    throw new Error(
      `Fiscal period bounds disagree with deriveFiscalPeriod for ${instant.toISOString()}`,
    );
  }
  return Object.freeze({ year, quarter });
}

// ---------------------------------------------------------------------------
// Calendar months (UTC)
// ---------------------------------------------------------------------------

const CALENDAR_MONTH_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function isSupportedKeyYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_KEY_YEAR && year <= MAX_KEY_YEAR;
}

/** Formats a calendar-month key such as "2026-11". `month` is 1–12. */
export function formatCalendarMonthKey(year: number, month: number): string {
  if (!isSupportedKeyYear(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid calendar month ${year}-${month}`);
  }
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

function buildCalendarMonth(year: number, month: number): CalendarMonthPeriod {
  return Object.freeze({
    kind: "calendar-month",
    granularity: "month",
    key: formatCalendarMonthKey(year, month),
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    year,
    month,
    startUtc: utcMidnight(year, month - 1, 1).toISOString(),
    endExclusiveUtc: utcMidnight(year, month, 1).toISOString(),
  });
}

/** The calendar month for a key such as "2026-11", or null if the key is malformed. */
export function getCalendarMonthPeriod(key: string): CalendarMonthPeriod | null {
  const match = typeof key === "string" ? CALENDAR_MONTH_KEY_PATTERN.exec(key) : null;
  if (!match) return null;
  const year = Number(match[1]);
  return isSupportedKeyYear(year) ? buildCalendarMonth(year, Number(match[2])) : null;
}

/** The UTC calendar month containing an instant, or null for invalid input. */
export function getCalendarMonthForDate(
  input: ReportingInstantInput | null | undefined,
): CalendarMonthPeriod | null {
  const instant = toValidInstant(input);
  if (!instant) return null;
  const year = instant.getUTCFullYear();
  return isSupportedKeyYear(year) ? buildCalendarMonth(year, instant.getUTCMonth() + 1) : null;
}

// ---------------------------------------------------------------------------
// Academic periods (Eastern time)
// ---------------------------------------------------------------------------

const ACADEMIC_YEAR_PATTERN = /^AY(\d{4})-(\d{4})$/;

/**
 * Supported academic years: AY1000-1001 through AY9997-9998. The upper bound
 * leaves room for the day after any date in the year (the exclusive end) to
 * remain a four-digit date.
 */
const MIN_ACADEMIC_START_YEAR = MIN_KEY_YEAR;
const MAX_ACADEMIC_END_YEAR = MAX_KEY_YEAR - 1;

const TERM_KEY_SUFFIX: Record<AcademicTerm, string> = {
  fall: "FALL",
  spring: "SPRING",
  summer: "SUMMER",
};

const TERM_LABEL: Record<AcademicTerm, string> = {
  fall: "Fall",
  spring: "Spring",
  summer: "Summer",
};

const SESSION_KEY_SUFFIX: Record<SummerSession, string> = {
  "summer-1": "SUMMER-1",
  "summer-2": "SUMMER-2",
  "summer-10wk": "SUMMER-10WK",
};

const SESSION_LABEL: Record<SummerSession, string> = {
  "summer-1": "Summer Session I",
  "summer-2": "Summer Session II",
  "summer-10wk": "Summer 10-Week Session",
};

const localDateSchema = z
  .string()
  .refine(isValidLocalDate, { message: "must be a real calendar date in YYYY-MM-DD format" });

const localDateRangeSchema = z
  .object({ startDate: localDateSchema, endDate: localDateSchema })
  .strict()
  .refine((range) => !isValidRange(range) || range.startDate <= range.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"],
  });

const academicCalendarSourceSchema = z
  .object({
    url: z.string().url().startsWith("https://", { message: "must be an https URL" }),
    publishedBy: z.string().trim().min(1),
    retrievedOn: localDateSchema,
  })
  .strict();

function isValidRange(range: { startDate: unknown; endDate: unknown }): boolean {
  return isValidLocalDate(range.startDate) && isValidLocalDate(range.endDate);
}

/**
 * The Summer term's local dates. Each boundary is the official semester date
 * if published, otherwise the earliest session start or latest session end.
 */
function summerTermRange(summer: AcademicCalendarYear["summer"]): LocalDateRange {
  const sessions = SUMMER_SESSIONS.map((session) => summer.sessions[session]);
  return {
    startDate: summer.startDate ?? sessions.map((s) => s.startDate).sort()[0],
    endDate: summer.endDate ?? sessions.map((s) => s.endDate).sort()[sessions.length - 1],
  };
}

function allDatesValid(year: AcademicCalendarYear): boolean {
  const ranges = [year.fall, year.spring, ...SUMMER_SESSIONS.map((s) => year.summer.sessions[s])];
  const optional = [year.summer.startDate, year.summer.endDate].filter((d) => d !== undefined);
  return ranges.every(isValidRange) && optional.every(isValidLocalDate);
}

const academicCalendarYearSchema = z
  .object({
    academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, "must match AYyyyy-yyyy"),
    sources: z
      .array(academicCalendarSourceSchema)
      .min(1, "at least one official source is required"),
    fall: localDateRangeSchema,
    spring: localDateRangeSchema,
    summer: z
      .object({
        sessions: z
          .object({
            "summer-1": localDateRangeSchema,
            "summer-2": localDateRangeSchema,
            "summer-10wk": localDateRangeSchema,
          })
          .strict(),
        startDate: localDateSchema.optional(),
        endDate: localDateSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((year, ctx) => {
    const yearMatch = ACADEMIC_YEAR_PATTERN.exec(year.academicYear);
    if (!yearMatch || !allDatesValid(year)) return; // already reported by field checks
    const startYear = Number(yearMatch[1]);
    const endYear = Number(yearMatch[2]);
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (endYear !== startYear + 1) {
      issue(["academicYear"], "end year must be the year after the start year");
      return;
    }
    // Checked before anything else so unsupported years fail validation here
    // instead of failing later during time zone conversion.
    if (startYear < MIN_ACADEMIC_START_YEAR || endYear > MAX_ACADEMIC_END_YEAR) {
      issue(
        ["academicYear"],
        `only AY${MIN_ACADEMIC_START_YEAR}-${MIN_ACADEMIC_START_YEAR + 1} through ` +
          `AY${MAX_ACADEMIC_END_YEAR - 1}-${MAX_ACADEMIC_END_YEAR} are supported`,
      );
      return;
    }

    // Every date must sit in the calendar year its term belongs to. Fall may
    // end in January; Spring and every Summer date fall in the end year, which
    // also bounds Summer for the last year in a calendar.
    const requireYear = (
      path: (string | number)[],
      date: string | undefined,
      allowed: readonly number[],
    ) => {
      if (date !== undefined && !allowed.includes(Number(date.slice(0, 4)))) {
        issue(path, `must be in ${allowed.join(" or ")} for ${year.academicYear}`);
      }
    };
    requireYear(["fall", "startDate"], year.fall.startDate, [startYear]);
    requireYear(["fall", "endDate"], year.fall.endDate, [startYear, endYear]);
    requireYear(["spring", "startDate"], year.spring.startDate, [endYear]);
    requireYear(["spring", "endDate"], year.spring.endDate, [endYear]);
    requireYear(["summer", "startDate"], year.summer.startDate, [endYear]);
    requireYear(["summer", "endDate"], year.summer.endDate, [endYear]);
    for (const session of SUMMER_SESSIONS) {
      const range = year.summer.sessions[session];
      requireYear(["summer", "sessions", session, "startDate"], range.startDate, [endYear]);
      requireYear(["summer", "sessions", session, "endDate"], range.endDate, [endYear]);
    }

    const { startDate: summerStart, endDate: summerEnd } = year.summer;
    if (summerStart && summerEnd && summerStart > summerEnd) {
      issue(["summer", "endDate"], "startDate must be on or before endDate");
      return;
    }

    const summer = summerTermRange(year.summer);
    for (const session of SUMMER_SESSIONS) {
      const range = year.summer.sessions[session];
      if (range.startDate < summer.startDate || range.endDate > summer.endDate) {
        issue(["summer", "sessions", session], "session must fall within the Summer term");
      }
    }

    // Sessions may overlap, but must keep their published order: Session I
    // comes before Session II, and the 10-Week Session spans across both.
    const {
      "summer-1": sessionOne,
      "summer-2": sessionTwo,
      "summer-10wk": tenWeek,
    } = year.summer.sessions;
    if (sessionTwo.startDate <= sessionOne.startDate) {
      issue(
        ["summer", "sessions", "summer-2", "startDate"],
        "Summer Session II must start after Summer Session I starts",
      );
    }
    if (sessionOne.endDate >= sessionTwo.endDate) {
      issue(
        ["summer", "sessions", "summer-1", "endDate"],
        "Summer Session I must end before Summer Session II ends",
      );
    }
    if (tenWeek.startDate >= sessionTwo.startDate) {
      issue(
        ["summer", "sessions", "summer-10wk", "startDate"],
        "Summer 10-Week Session must start before Summer Session II starts",
      );
    }
    if (tenWeek.endDate <= sessionOne.endDate) {
      issue(
        ["summer", "sessions", "summer-10wk", "endDate"],
        "Summer 10-Week Session must end after Summer Session I ends",
      );
    }

    if (year.fall.endDate >= year.spring.startDate) {
      issue(["spring", "startDate"], "Spring must start after Fall ends");
    }
    if (year.spring.endDate >= summer.startDate) {
      issue(["summer"], "Summer must start after Spring ends");
    }
  });

export const academicCalendarSchema = z
  .array(academicCalendarYearSchema)
  .min(1, "at least one academic year is required")
  .superRefine((years, ctx) => {
    const seen = new Set<string>();
    years.forEach((year, index) => {
      if (seen.has(year.academicYear)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "academicYear"],
          message: `duplicate academic year ${year.academicYear}`,
        });
      }
      seen.add(year.academicYear);
    });

    if (!years.every(allDatesValid)) return;
    const ordered = [...years].sort((a, b) => a.fall.startDate.localeCompare(b.fall.startDate));
    for (let i = 1; i < ordered.length; i += 1) {
      if (summerTermRange(ordered[i - 1].summer).endDate >= ordered[i].fall.startDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [years.indexOf(ordered[i]), "fall", "startDate"],
          message: `${ordered[i].academicYear} overlaps ${ordered[i - 1].academicYear}`,
        });
      }
    }
  });

export type AcademicCalendarValidationResult =
  | { ok: true; data: AcademicCalendar }
  | { ok: false; errors: string[] };

/** Checks calendar data against academicCalendarSchema. */
export function validateAcademicCalendar(candidate: unknown): AcademicCalendarValidationResult {
  const parsed = academicCalendarSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "calendar"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

function localBounds(range: LocalDateRange): PeriodBounds {
  return {
    startUtc: zonedLocalMidnightToUtc(range.startDate, ACADEMIC_TIME_ZONE).toISOString(),
    endExclusiveUtc: zonedLocalMidnightToUtc(
      nextLocalDate(range.endDate),
      ACADEMIC_TIME_ZONE,
    ).toISOString(),
  };
}

function buildAcademicYearPeriods(year: AcademicCalendarYear): AcademicPeriod[] {
  const makeTerm = (
    term: AcademicTerm,
    range: LocalDateRange,
    sessionKeys: readonly string[],
  ): AcademicTermPeriod =>
    Object.freeze({
      kind: "academic",
      granularity: "term",
      key: `${year.academicYear}-${TERM_KEY_SUFFIX[term]}`,
      label: `${TERM_LABEL[term]} ${range.startDate.slice(0, 4)}`,
      academicYear: year.academicYear,
      term,
      sessionKeys: Object.freeze([...sessionKeys]),
      timeZone: ACADEMIC_TIME_ZONE,
      localStartDate: range.startDate,
      localEndDate: range.endDate,
      ...localBounds(range),
    });

  const summerKey = `${year.academicYear}-${TERM_KEY_SUFFIX.summer}`;
  const sessions = SUMMER_SESSIONS.map((session): AcademicSessionPeriod => {
    const range = year.summer.sessions[session];
    return Object.freeze({
      kind: "academic",
      granularity: "session",
      key: `${year.academicYear}-${SESSION_KEY_SUFFIX[session]}`,
      label: `${SESSION_LABEL[session]} ${range.startDate.slice(0, 4)}`,
      academicYear: year.academicYear,
      term: "summer",
      session,
      parentKey: summerKey,
      timeZone: ACADEMIC_TIME_ZONE,
      localStartDate: range.startDate,
      localEndDate: range.endDate,
      ...localBounds(range),
    });
  });

  return [
    makeTerm("fall", year.fall, []),
    makeTerm("spring", year.spring, []),
    makeTerm(
      "summer",
      summerTermRange(year.summer),
      sessions.map((session) => session.key),
    ),
    ...sessions,
  ];
}

interface AcademicPeriodCacheEntry {
  readonly periods: readonly AcademicPeriod[];
  /**
   * JSON snapshot of the calendar when the periods were built, or null when
   * the calendar is deeply frozen and so cannot have changed.
   */
  readonly snapshot: string | null;
}

const academicPeriodCache = new WeakMap<AcademicCalendar, AcademicPeriodCacheEntry>();

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

function snapshotCalendar(calendar: AcademicCalendar): string | undefined {
  try {
    return JSON.stringify(calendar);
  } catch {
    return undefined; // not serializable (e.g. circular); never cached
  }
}

/** Position of a period among periods that start at the same instant. */
function sameStartRank(period: AcademicPeriod): number {
  return period.granularity === "term" ? -1 : SUMMER_SESSIONS.indexOf(period.session);
}

/**
 * Builds every academic period (terms and Summer sessions) from calendar data.
 *
 * Order: by start instant, earliest first. Periods that start at the same
 * instant list the term first, then sessions in SUMMER_SESSIONS order
 * (Session I, Session II, 10-Week).
 *
 * Caching: results are cached per calendar object.
 * - A deeply frozen calendar (such as HOWARD_ACADEMIC_CALENDAR) cannot
 *   change, so its cached periods are reused by reference.
 * - For any other calendar, a JSON snapshot is compared on each call. An
 *   unchanged calendar reuses its cached periods without rebuilding; a calendar
 *   changed since the last call is validated and rebuilt, never served stale.
 *   Deep-freeze calendars used on hot paths to skip the snapshot comparison.
 *
 * @throws Error if the data fails validateAcademicCalendar().
 */
export function buildAcademicPeriods(
  calendar: AcademicCalendar = HOWARD_ACADEMIC_CALENDAR,
): readonly AcademicPeriod[] {
  const cached = academicPeriodCache.get(calendar);
  if (cached && (cached.snapshot === null || cached.snapshot === snapshotCalendar(calendar))) {
    return cached.periods;
  }

  const validation = validateAcademicCalendar(calendar);
  if (!validation.ok) {
    throw new Error(`Invalid academic calendar: ${validation.errors.join("; ")}`);
  }
  const periods = Object.freeze(
    validation.data
      .flatMap(buildAcademicYearPeriods)
      .sort(
        (a, b) =>
          Date.parse(a.startUtc) - Date.parse(b.startUtc) ||
          sameStartRank(a) - sameStartRank(b) ||
          a.key.localeCompare(b.key),
      ),
  );
  const snapshot = isDeeplyFrozen(calendar) ? null : snapshotCalendar(calendar);
  if (snapshot !== undefined) academicPeriodCache.set(calendar, { periods, snapshot });
  return periods;
}

/** An academic term or session by key, e.g. "AY2026-2027-SUMMER-1", or null. */
export function getAcademicPeriodByKey(
  key: string,
  calendar: AcademicCalendar = HOWARD_ACADEMIC_CALENDAR,
): AcademicPeriod | null {
  return buildAcademicPeriods(calendar).find((period) => period.key === key) ?? null;
}

/**
 * Every academic period containing an instant: the term and, in Summer, each
 * session that includes it. Summer sessions may overlap, so several sessions
 * can match. Returns [] for invalid input, breaks between terms, and dates
 * outside the calendar data.
 *
 * Order (same as buildAcademicPeriods): by start instant, earliest first;
 * periods starting at the same instant list the term first, then sessions in
 * SUMMER_SESSIONS order. Because the Summer term starts with or before its
 * sessions, it is always first. For example, on June 21, 2026 the result is
 * Summer, Session I, 10-Week, Session II (Session II started later). Identify
 * periods by `granularity`, `session` or `key` rather than by position.
 *
 * @throws Error if the calendar data fails validateAcademicCalendar().
 */
export function findAcademicPeriodsForDate(
  input: ReportingInstantInput | null | undefined,
  calendar: AcademicCalendar = HOWARD_ACADEMIC_CALENDAR,
): readonly AcademicPeriod[] {
  const instant = toValidInstant(input);
  if (!instant) return [];
  return buildAcademicPeriods(calendar).filter((period) => isWithinPeriod(period, instant));
}

/**
 * The academic term (Fall, Spring or Summer) containing an instant, or null.
 * Terms never overlap. Use findAcademicPeriodsForDate() to include Summer sessions.
 */
export function getAcademicTermForDate(
  input: ReportingInstantInput | null | undefined,
  calendar: AcademicCalendar = HOWARD_ACADEMIC_CALENDAR,
): AcademicTermPeriod | null {
  return (
    findAcademicPeriodsForDate(input, calendar).find(
      (period): period is AcademicTermPeriod => period.granularity === "term",
    ) ?? null
  );
}
