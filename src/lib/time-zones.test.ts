import { readFileSync } from "node:fs";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as reportingPeriods from "./reporting-periods";
import {
  ACADEMIC_TIME_ZONE,
  REPORTING_PERIOD_KINDS,
  REPORTING_PERIOD_TIME_ZONES,
  buildAcademicPeriods,
  formatCalendarMonthKey,
  getAcademicCalendarCoverage,
  getCalendarMonthPeriod,
  getFiscalQuartersForYear,
  getFiscalYearPeriod,
  type PeriodBounds,
} from "./reporting-periods";
import * as timeZones from "./time-zones";
import {
  INSTITUTION_TIME_ZONE,
  UTC_TIME_ZONE,
  formatInstant,
  isValidTimeZone,
  localDateRangeToUtcBounds,
  nextLocalDate,
  resolveViewerTimeZone,
  toZonedLocalDate,
  zonedLocalMidnightToUtc,
  zonedToday,
} from "./time-zones";

/**
 * F18.3 time zone handling. Existing F18.1/F18.2 tests are deliberately left
 * unchanged in reporting-periods.test.ts and reporting-period-config.test.ts.
 */

const NY = "America/New_York";
const HOUR_MS = 3_600_000;

/** ICU versions differ in the space before AM/PM (U+0020 vs U+202F). */
const normalizeSpaces = (value: string | null) => value?.replace(/\s+/g, " ") ?? null;

const midnight = (date: string, zone: string) => zonedLocalMidnightToUtc(date, zone).getTime();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("module boundaries", () => {
  it("time-zones.ts has no imports, so it can never be part of an import cycle", () => {
    const source = readFileSync(new URL("./time-zones.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*export\b[^;]*\bfrom\s+["']/m);
  });

  it("reporting-periods.ts re-exports the moved helpers as the same functions", () => {
    expect(reportingPeriods.isValidLocalDate).toBe(timeZones.isValidLocalDate);
    expect(reportingPeriods.nextLocalDate).toBe(timeZones.nextLocalDate);
    expect(reportingPeriods.toValidInstant).toBe(timeZones.toValidInstant);
    expect(reportingPeriods.zonedLocalMidnightToUtc).toBe(timeZones.zonedLocalMidnightToUtc);
  });

  it("keeps the re-exported types and the academic zone literal type", () => {
    expectTypeOf<reportingPeriods.PeriodBounds>().toEqualTypeOf<timeZones.PeriodBounds>();
    expectTypeOf<reportingPeriods.LocalDateRange>().toEqualTypeOf<timeZones.LocalDateRange>();
    expectTypeOf<reportingPeriods.ReportingInstantInput>().toEqualTypeOf<timeZones.InstantInput>();
    expectTypeOf(ACADEMIC_TIME_ZONE).toEqualTypeOf<"America/New_York">();
    expect(ACADEMIC_TIME_ZONE).toBe("America/New_York");
  });
});

describe("isValidTimeZone", () => {
  it.each([NY, "UTC", "Asia/Kathmandu", "Etc/GMT+5", "Pacific/Kiritimati"])(
    "accepts %s",
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(true);
    },
  );

  it.each(["", " ", "Mars/Olympus_Mons", "America/New York", null, undefined, 123, {}, ["UTC"]])(
    "rejects %j without throwing",
    (value) => {
      expect(() => isValidTimeZone(value)).not.toThrow();
      expect(isValidTimeZone(value)).toBe(false);
    },
  );
});

describe("zonedLocalMidnightToUtc (F18.3 additions)", () => {
  it("handles zones with unusual offsets", () => {
    expect(zonedLocalMidnightToUtc("2026-01-02", "Asia/Kathmandu").toISOString()).toBe(
      "2026-01-01T18:15:00.000Z",
    );
    expect(zonedLocalMidnightToUtc("2027-01-01", "Pacific/Kiritimati").toISOString()).toBe(
      "2026-12-31T10:00:00.000Z",
    );
    expect(zonedLocalMidnightToUtc("2027-01-01", "Pacific/Pago_Pago").toISOString()).toBe(
      "2027-01-01T11:00:00.000Z",
    );
  });

  it("follows a 30-minute DST shift (Lord Howe Island)", () => {
    // DST starts 2026-10-04 at 02:00, moving from +10:30 to +11.
    expect(zonedLocalMidnightToUtc("2026-10-04", "Australia/Lord_Howe").toISOString()).toBe(
      "2026-10-03T13:30:00.000Z",
    );
    expect(zonedLocalMidnightToUtc("2026-10-05", "Australia/Lord_Howe").toISOString()).toBe(
      "2026-10-04T13:00:00.000Z",
    );
  });

  it("throws when local midnight does not exist (DST starting at midnight)", () => {
    expect(() => zonedLocalMidnightToUtc("2026-09-06", "America/Santiago")).toThrow(RangeError);
    expect(() => zonedLocalMidnightToUtc("2026-03-08", "America/Havana")).toThrow(RangeError);
    // The days around them are fine.
    expect(() => zonedLocalMidnightToUtc("2026-09-05", "America/Santiago")).not.toThrow();
    expect(() => zonedLocalMidnightToUtc("2026-09-07", "America/Santiago")).not.toThrow();
  });

  it("throws a RangeError for an invalid zone", () => {
    expect(() => zonedLocalMidnightToUtc("2026-01-01", "Mars/Olympus_Mons")).toThrow(RangeError);
  });

  it("still defaults to the institution zone (F18.1 compatibility)", () => {
    expect(zonedLocalMidnightToUtc("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});

describe("toZonedLocalDate", () => {
  it.each([
    // America/New_York, winter (EST, -05:00) and summer (EDT, -04:00).
    ["2026-01-15T04:59:59.999Z", NY, "2026-01-14"],
    ["2026-01-15T05:00:00.000Z", NY, "2026-01-15"],
    ["2026-07-15T03:59:59.999Z", NY, "2026-07-14"],
    ["2026-07-15T04:00:00.000Z", NY, "2026-07-15"],
    // DST starts 2026-03-08 (a 23-hour day).
    ["2026-03-08T04:59:59.999Z", NY, "2026-03-07"],
    ["2026-03-08T05:00:00.000Z", NY, "2026-03-08"],
    ["2026-03-09T03:59:59.999Z", NY, "2026-03-08"],
    ["2026-03-09T04:00:00.000Z", NY, "2026-03-09"],
    // DST ends 2026-11-01 (a 25-hour day).
    ["2026-11-01T03:59:59.999Z", NY, "2026-10-31"],
    ["2026-11-01T04:00:00.000Z", NY, "2026-11-01"],
    ["2026-11-02T04:59:59.999Z", NY, "2026-11-01"],
    ["2026-11-02T05:00:00.000Z", NY, "2026-11-02"],
    // Year boundary: the same instant is in different years in different zones.
    ["2026-12-31T23:30:00-05:00", NY, "2026-12-31"],
    ["2026-12-31T23:30:00-05:00", "UTC", "2027-01-01"],
    ["2026-12-31T10:00:00Z", "Pacific/Kiritimati", "2027-01-01"],
    ["2026-12-31T09:59:59.999Z", "Pacific/Kiritimati", "2026-12-31"],
    ["2027-01-01T10:59:59.999Z", "Pacific/Pago_Pago", "2026-12-31"],
    ["2027-01-01T11:00:00Z", "Pacific/Pago_Pago", "2027-01-01"],
    // Leap day.
    ["2028-02-29T04:59:59.999Z", NY, "2028-02-28"],
    ["2028-02-29T05:00:00.000Z", NY, "2028-02-29"],
    ["2028-03-01T04:59:59.999Z", NY, "2028-02-29"],
    ["2028-03-01T05:00:00.000Z", NY, "2028-03-01"],
    // Half- and quarter-hour offsets.
    ["2026-01-01T18:29:59.999Z", "Asia/Kolkata", "2026-01-01"],
    ["2026-01-01T18:30:00Z", "Asia/Kolkata", "2026-01-02"],
    ["2026-01-01T18:14:59.999Z", "Asia/Kathmandu", "2026-01-01"],
    ["2026-01-01T18:15:00Z", "Asia/Kathmandu", "2026-01-02"],
  ])("%s in %s is %s", (instant, zone, expected) => {
    expect(toZonedLocalDate(instant, zone)).toBe(expected);
  });

  it("accepts a Date and epoch milliseconds without mutating the Date", () => {
    const date = new Date("2026-11-18T03:00:00Z");
    expect(toZonedLocalDate(date, NY)).toBe("2026-11-17");
    expect(toZonedLocalDate(date.getTime(), NY)).toBe("2026-11-17");
    expect(date.toISOString()).toBe("2026-11-18T03:00:00.000Z");
  });

  it.each([
    ["an invalid Date", new Date(Number.NaN)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a date-only string", "2026-11-01"],
    ["a timestamp without an offset", "2026-11-01T00:00:00"],
    ["February 29 in a non-leap year", "2027-02-29T12:00:00Z"],
    ["null", null],
    ["undefined", undefined],
  ])("returns null for %s", (_label, input) => {
    expect(toZonedLocalDate(input, NY)).toBeNull();
  });

  it("returns null within a day of the four-digit year limits", () => {
    expect(toZonedLocalDate("0001-01-01T12:00:00Z", "UTC")).toBeNull();
    expect(toZonedLocalDate("0001-01-02T00:00:00Z", "UTC")).toBe("0001-01-02");
    expect(toZonedLocalDate("9999-12-30T23:59:59.999Z", "UTC")).toBe("9999-12-30");
    expect(toZonedLocalDate("9999-12-31T00:00:00Z", "UTC")).toBeNull();
  });

  it("throws a RangeError for an invalid zone", () => {
    expect(() => toZonedLocalDate("2026-01-01T00:00:00Z", "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => toZonedLocalDate("2026-01-01T00:00:00Z", "")).toThrow(RangeError);
  });
});

describe("local date and local midnight round trip", () => {
  const zones = [
    NY,
    "UTC",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
    "Australia/Lord_Howe",
  ];

  it.each(zones)("round-trips every date from 2024 through 2028 in %s", (zone) => {
    const mismatches: string[] = [];
    let previous = "2023-12-31";
    for (let date = "2024-01-01"; date <= "2028-12-31"; date = nextLocalDate(date)) {
      const start = midnight(date, zone);
      if (toZonedLocalDate(start, zone) !== date) mismatches.push(`${date} start`);
      if (toZonedLocalDate(start - 1, zone) !== previous) mismatches.push(`${date} start - 1ms`);
      previous = date;
    }
    expect(mismatches).toEqual([]);
  });

  it("has exactly one 23-hour and one 25-hour day in America/New_York in 2026", () => {
    const lengths = new Map<string, number>();
    for (let date = "2026-01-01"; date <= "2026-12-31"; date = nextLocalDate(date)) {
      const hours = (midnight(nextLocalDate(date), NY) - midnight(date, NY)) / HOUR_MS;
      if (hours !== 24) lengths.set(date, hours);
    }
    expect(Object.fromEntries(lengths)).toEqual({ "2026-03-08": 23, "2026-11-01": 25 });
  });
});

describe("zonedToday", () => {
  const now = new Date("2026-11-18T04:30:00Z");

  it("uses the given zone's calendar day", () => {
    expect(zonedToday(NY, now)).toBe("2026-11-17");
    expect(zonedToday(UTC_TIME_ZONE, now)).toBe("2026-11-18");
    expect(zonedToday("Asia/Kolkata", now.getTime())).toBe("2026-11-18");
  });

  it("uses the current time when `now` is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(zonedToday(NY)).toBe("2026-11-17");
    expect(zonedToday(UTC_TIME_ZONE)).toBe("2026-11-18");
  });

  it("throws instead of falling back for an invalid `now` or zone", () => {
    expect(() => zonedToday(NY, new Date(Number.NaN))).toThrow(RangeError);
    expect(() => zonedToday(NY, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => zonedToday("Mars/Olympus_Mons", now)).toThrow(RangeError);
  });
});

describe("localDateRangeToUtcBounds", () => {
  it.each<[string, string, string, string, PeriodBounds]>([
    [
      "single winter day",
      "2026-01-15",
      "2026-01-15",
      NY,
      { startUtc: "2026-01-15T05:00:00.000Z", endExclusiveUtc: "2026-01-16T05:00:00.000Z" },
    ],
    [
      "single summer day",
      "2026-07-15",
      "2026-07-15",
      NY,
      { startUtc: "2026-07-15T04:00:00.000Z", endExclusiveUtc: "2026-07-16T04:00:00.000Z" },
    ],
    [
      "ends on the day DST starts",
      "2026-03-01",
      "2026-03-08",
      NY,
      { startUtc: "2026-03-01T05:00:00.000Z", endExclusiveUtc: "2026-03-09T04:00:00.000Z" },
    ],
    [
      "ends on the day DST ends",
      "2026-10-25",
      "2026-11-01",
      NY,
      { startUtc: "2026-10-25T04:00:00.000Z", endExclusiveUtc: "2026-11-02T05:00:00.000Z" },
    ],
    [
      "spans the spring DST change",
      "2026-02-01",
      "2026-04-30",
      NY,
      { startUtc: "2026-02-01T05:00:00.000Z", endExclusiveUtc: "2026-05-01T04:00:00.000Z" },
    ],
    [
      "leap day",
      "2028-02-29",
      "2028-02-29",
      NY,
      { startUtc: "2028-02-29T05:00:00.000Z", endExclusiveUtc: "2028-03-01T05:00:00.000Z" },
    ],
    [
      "crosses the year boundary",
      "2026-12-31",
      "2027-01-01",
      NY,
      { startUtc: "2026-12-31T05:00:00.000Z", endExclusiveUtc: "2027-01-02T05:00:00.000Z" },
    ],
    [
      "UTC",
      "2026-11-01",
      "2026-11-30",
      "UTC",
      { startUtc: "2026-11-01T00:00:00.000Z", endExclusiveUtc: "2026-12-01T00:00:00.000Z" },
    ],
    [
      "Kiritimati (+14)",
      "2027-01-01",
      "2027-01-01",
      "Pacific/Kiritimati",
      { startUtc: "2026-12-31T10:00:00.000Z", endExclusiveUtc: "2027-01-01T10:00:00.000Z" },
    ],
  ])("%s", (_label, startDate, endDate, zone, expected) => {
    expect(localDateRangeToUtcBounds({ startDate, endDate }, zone)).toEqual(expected);
  });

  it.each([
    ["start after end", { startDate: "2026-02-01", endDate: "2026-01-31" }, NY],
    ["February 29 in a non-leap year", { startDate: "2027-02-29", endDate: "2027-03-01" }, NY],
    ["an unpadded date", { startDate: "2026-1-1", endDate: "2026-01-02" }, NY],
    [
      "a timestamp instead of a date",
      { startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-02" },
      NY,
    ],
    ["an end date of 9999-12-31", { startDate: "9999-12-01", endDate: "9999-12-31" }, "UTC"],
    [
      "a local midnight that does not exist",
      { startDate: "2026-09-06", endDate: "2026-09-10" },
      "America/Santiago",
    ],
    ["an invalid zone", { startDate: "2026-01-01", endDate: "2026-01-02" }, "Mars/Olympus_Mons"],
    ["an empty zone", { startDate: "2026-01-01", endDate: "2026-01-02" }, ""],
  ])("throws a RangeError for %s", (_label, range, zone) => {
    expect(() => localDateRangeToUtcBounds(range, zone)).toThrow(RangeError);
  });
});

describe("resolveViewerTimeZone (display only)", () => {
  const mockResolvedTimeZone = (timeZone: unknown) => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
    });
  };

  it("returns the runtime's zone when it is valid", () => {
    mockResolvedTimeZone("Asia/Tokyo");
    expect(resolveViewerTimeZone()).toBe("Asia/Tokyo");
  });

  it.each([undefined, "", "Mars/Olympus_Mons"])(
    "falls back when the runtime reports %j",
    (zone) => {
      mockResolvedTimeZone(zone);
      expect(resolveViewerTimeZone()).toBe(INSTITUTION_TIME_ZONE);
      expect(resolveViewerTimeZone("UTC")).toBe("UTC");
    },
  );

  it("falls back when reading the runtime's zone throws", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(resolveViewerTimeZone()).toBe(INSTITUTION_TIME_ZONE);
  });

  it("throws a RangeError when the fallback itself is invalid", () => {
    expect(() => resolveViewerTimeZone("Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

describe("formatInstant (display only)", () => {
  const instant = "2026-11-18T01:00:00Z";

  it("formats in the given zone with the short zone name", () => {
    expect(normalizeSpaces(formatInstant(instant, { timeZone: NY }))).toBe(
      "Nov 17, 2026, 8:00 PM EST",
    );
    expect(normalizeSpaces(formatInstant("2026-07-01T16:00:00Z", { timeZone: NY }))).toBe(
      "Jul 1, 2026, 12:00 PM EDT",
    );
    expect(normalizeSpaces(formatInstant(instant, { timeZone: "Asia/Kolkata" }))).toBe(
      "Nov 18, 2026, 6:30 AM GMT+5:30",
    );
    expect(normalizeSpaces(formatInstant(instant, { timeZone: "UTC" }))).toBe(
      "Nov 18, 2026, 1:00 AM UTC",
    );
  });

  it("can leave out the time or the zone name", () => {
    expect(normalizeSpaces(formatInstant(instant, { timeZone: NY, includeTime: false }))).toBe(
      "Nov 17, 2026, EST",
    );
    expect(
      normalizeSpaces(formatInstant(instant, { timeZone: NY, includeTimeZoneName: false })),
    ).toBe("Nov 17, 2026, 8:00 PM");
  });

  it("accepts Dates and epoch milliseconds", () => {
    const expected = formatInstant(instant, { timeZone: NY });
    expect(formatInstant(new Date(instant), { timeZone: NY })).toBe(expected);
    expect(formatInstant(Date.parse(instant), { timeZone: NY })).toBe(expected);
  });

  it("returns null for an invalid instant", () => {
    expect(formatInstant("2026-11-18", { timeZone: NY })).toBeNull();
    expect(formatInstant(new Date(Number.NaN), { timeZone: NY })).toBeNull();
    expect(formatInstant(null, { timeZone: NY })).toBeNull();
  });

  it("throws a RangeError for an invalid zone or locale", () => {
    expect(() => formatInstant(instant, { timeZone: "Mars/Olympus_Mons" })).toThrow(RangeError);
    expect(() => formatInstant(instant, { timeZone: NY, locale: "not a locale!" })).toThrow(
      RangeError,
    );
  });
});

describe("reporting period time zone policy", () => {
  it("names a zone for exactly the reporting period kinds, and is frozen", () => {
    expect(Object.keys(REPORTING_PERIOD_TIME_ZONES).sort()).toEqual(
      [...REPORTING_PERIOD_KINDS].sort(),
    );
    expect(Object.isFrozen(REPORTING_PERIOD_TIME_ZONES)).toBe(true);
    expect(REPORTING_PERIOD_TIME_ZONES).toEqual({
      fiscal: "UTC",
      "calendar-month": "UTC",
      academic: "America/New_York",
    });
    expect(REPORTING_PERIOD_TIME_ZONES.academic).toBe(ACADEMIC_TIME_ZONE);
    expect(ACADEMIC_TIME_ZONE).toBe(INSTITUTION_TIME_ZONE);
  });

  /** True when the instant is local midnight in `zone`. */
  const isLocalMidnight = (iso: string, zone: string) => {
    const date = toZonedLocalDate(iso, zone);
    return date !== null && zonedLocalMidnightToUtc(date, zone).toISOString() === iso;
  };

  it("matches the fiscal period boundaries (local midnights in UTC)", () => {
    const zone = REPORTING_PERIOD_TIME_ZONES.fiscal;
    const bounds: string[] = [];
    for (let year = 2025; year <= 2029; year++) {
      const fiscalYear = getFiscalYearPeriod(`FY${year}`);
      const quarters = getFiscalQuartersForYear(`FY${year}`);
      expect(fiscalYear).not.toBeNull();
      expect(quarters).not.toBeNull();
      for (const period of [fiscalYear!, ...quarters!]) {
        bounds.push(period.startUtc, period.endExclusiveUtc);
      }
    }
    expect(bounds.filter((iso) => !isLocalMidnight(iso, zone))).toEqual([]);
    // Not local midnights in Eastern time, which is why the policy says UTC.
    expect(isLocalMidnight(getFiscalYearPeriod("FY2027")!.startUtc, NY)).toBe(false);
  });

  it("matches the calendar month boundaries (local midnights in UTC)", () => {
    const zone = REPORTING_PERIOD_TIME_ZONES["calendar-month"];
    const bounds: string[] = [];
    for (let year = 2025; year <= 2028; year++) {
      for (let month = 1; month <= 12; month++) {
        const period = getCalendarMonthPeriod(formatCalendarMonthKey(year, month));
        expect(period).not.toBeNull();
        bounds.push(period!.startUtc, period!.endExclusiveUtc);
      }
    }
    expect(bounds.filter((iso) => !isLocalMidnight(iso, zone))).toEqual([]);
  });

  it("reproduces every shipped academic period's bounds from its local dates", () => {
    const zone = REPORTING_PERIOD_TIME_ZONES.academic;
    const periods = buildAcademicPeriods();
    expect(periods.length).toBeGreaterThan(0);
    for (const period of periods) {
      expect(period.timeZone).toBe(zone);
      expect(
        localDateRangeToUtcBounds(
          { startDate: period.localStartDate, endDate: period.localEndDate },
          zone,
        ),
      ).toEqual({ startUtc: period.startUtc, endExclusiveUtc: period.endExclusiveUtc });
    }
    const coverage = getAcademicCalendarCoverage();
    expect(
      localDateRangeToUtcBounds(
        { startDate: coverage.localStartDate, endDate: coverage.localEndDate },
        zone,
      ),
    ).toEqual({ startUtc: coverage.startUtc, endExclusiveUtc: coverage.endExclusiveUtc });
  });
});

describe("host time zone independence", () => {
  /** Host zones with their January offsets, as Date#getTimezoneOffset reports them. */
  const HOST_ZONES: ReadonlyArray<[string, number]> = [
    ["UTC", 0],
    ["America/New_York", 300],
    ["America/Los_Angeles", 480],
    ["Pacific/Kiritimati", -840],
    ["Pacific/Pago_Pago", 660],
    ["Asia/Kolkata", -330],
    ["Asia/Kathmandu", -345],
  ];
  const originalTz = process.env.TZ;
  /** The runtime may report a legacy ID for a zone (e.g. Asia/Calcutta for Asia/Kolkata). */
  const canonical = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /** Loads fresh module instances so no cache carries results across host zones. */
  async function runBattery() {
    vi.resetModules();
    const tz = await import("./time-zones");
    const rp = await import("./reporting-periods");
    const instants = [
      "2026-03-08T06:59:59.999Z",
      "2026-08-31T21:00:00-04:00",
      "2026-11-01T05:30:00Z",
      "2026-12-16T23:59:59.999-05:00",
      "2026-12-31T23:30:00-05:00",
      "2028-02-29T04:59:59.999Z",
    ];
    return {
      zonedDates: instants.flatMap((instant) =>
        [NY, "UTC", "Asia/Kathmandu", "Pacific/Kiritimati"].map((zone) =>
          tz.toZonedLocalDate(instant, zone),
        ),
      ),
      midnights: ["2026-03-08", "2026-11-01", "2028-02-29"].map((date) =>
        tz.zonedLocalMidnightToUtc(date, NY).toISOString(),
      ),
      bounds: tz.localDateRangeToUtcBounds({ startDate: "2026-02-01", endDate: "2026-11-01" }, NY),
      today: tz.zonedToday(NY, Date.parse("2026-11-18T04:30:00Z")),
      formatted: tz.formatInstant("2026-11-18T01:00:00Z", { timeZone: NY }),
      academic: instants.map((instant) => rp.findAcademicPeriodsForDate(instant).map((p) => p.key)),
      fiscal: instants.map((instant) => rp.getFiscalPeriodsForDate(instant)?.quarter.key ?? null),
      months: instants.map((instant) => rp.getCalendarMonthForDate(instant)?.key ?? null),
      coverage: rp.getAcademicCalendarCoverage(),
      policy: rp.REPORTING_PERIOD_TIME_ZONES,
    };
  }

  it("gives identical results whatever the host time zone is", async () => {
    process.env.TZ = "UTC";
    const baseline = await runBattery();
    for (const [hostZone, januaryOffset] of HOST_ZONES) {
      process.env.TZ = hostZone;
      // Guard: fail loudly if the runtime did not actually switch zones, so this
      // test can never pass without testing anything.
      expect(new Date("2026-01-15T12:00:00Z").getTimezoneOffset()).toBe(januaryOffset);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(canonical(hostZone));
      expect(await runBattery(), `host zone ${hostZone}`).toEqual(baseline);
    }
  });

  it("lets only the display helper follow the host zone", () => {
    for (const [hostZone] of HOST_ZONES) {
      process.env.TZ = hostZone;
      expect(canonical(resolveViewerTimeZone())).toBe(canonical(hostZone));
    }
  });
});
