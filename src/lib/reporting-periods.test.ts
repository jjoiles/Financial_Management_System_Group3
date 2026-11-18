import { afterEach, describe, expect, it, vi } from "vitest";
import { HOWARD_ACADEMIC_CALENDAR } from "./howard-academic-calendar";
import {
  ACADEMIC_COVERAGE_STATUSES,
  ACADEMIC_TIME_ZONE,
  buildAcademicPeriods,
  findAcademicPeriodsForDate,
  formatCalendarMonthKey,
  getAcademicCalendarCoverage,
  getAcademicCoverageStatus,
  getAcademicPeriodByKey,
  getAcademicTermForDate,
  getCalendarMonthForDate,
  getCalendarMonthPeriod,
  getFiscalPeriodsForDate,
  getFiscalQuarterPeriod,
  getFiscalQuartersForYear,
  getFiscalYearPeriod,
  isValidLocalDate,
  isWithinPeriod,
  nextLocalDate,
  toValidInstant,
  validateAcademicCalendar,
  zonedLocalMidnightToUtc,
  type AcademicCalendar,
  type AcademicCalendarYear,
  type PeriodBounds,
} from "./reporting-periods";
import { deriveFiscalPeriod, derivedMetadataSchema } from "./request-utils";

const ms = (iso: string) => Date.parse(iso);
const minus1ms = (iso: string) => new Date(ms(iso) - 1);
const keys = (periods: readonly { key: string }[]) => periods.map((p) => p.key);

/** Checks the half-open rule at both edges of a period. */
function expectHalfOpen(period: PeriodBounds) {
  expect(isWithinPeriod(period, minus1ms(period.startUtc))).toBe(false);
  expect(isWithinPeriod(period, period.startUtc)).toBe(true);
  expect(isWithinPeriod(period, minus1ms(period.endExclusiveUtc))).toBe(true);
  expect(isWithinPeriod(period, period.endExclusiveUtc)).toBe(false);
}

/**
 * Synthetic calendar for edge cases the official data does not contain:
 * terms ending on DST-change days, explicit Summer term start and end dates,
 * and a gap between Summer sessions that is still inside the Summer term.
 */
const FIXTURE_YEAR: AcademicCalendarYear = {
  academicYear: "AY2026-2027",
  sources: [
    { url: "https://example.edu/calendar", publishedBy: "Fixture", retrievedOn: "2026-11-18" },
  ],
  fall: { startDate: "2026-08-17", endDate: "2026-11-01" }, // ends on the day DST ends
  spring: { startDate: "2027-01-11", endDate: "2027-03-14" }, // ends on the day DST starts
  summer: {
    startDate: "2027-05-10",
    endDate: "2027-07-31",
    sessions: {
      "summer-1": { startDate: "2027-05-17", endDate: "2027-05-31" },
      "summer-2": { startDate: "2027-07-01", endDate: "2027-07-15" },
      "summer-10wk": { startDate: "2027-05-24", endDate: "2027-06-10" },
    },
  },
};
const FIXTURE: AcademicCalendar = [FIXTURE_YEAR];

type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };
type EditableYear = DeepMutable<AcademicCalendarYear> & Record<string, unknown>;

/** A mutable copy of the fixture year, optionally changed. */
function editableYear(change: (year: EditableYear) => void = () => {}): EditableYear {
  const year = structuredClone(FIXTURE_YEAR) as EditableYear;
  change(year);
  return year;
}

/** A one-year calendar made from a changed copy of the fixture, for validation tests. */
function withYear(change: (year: EditableYear) => void): unknown {
  return [editableYear(change)];
}

/** A valid academic year shaped like the official 2026-2027 calendar, for any start year. */
function makeYear(startYear: number): AcademicCalendarYear {
  const s = String(startYear).padStart(4, "0");
  const e = String(startYear + 1).padStart(4, "0");
  return {
    academicYear: `AY${s}-${e}`,
    sources: FIXTURE_YEAR.sources,
    fall: { startDate: `${s}-08-17`, endDate: `${s}-12-16` },
    spring: { startDate: `${e}-01-11`, endDate: `${e}-05-07` },
    summer: {
      sessions: {
        "summer-1": { startDate: `${e}-05-17`, endDate: `${e}-06-20` },
        "summer-2": { startDate: `${e}-06-21`, endDate: `${e}-07-24` },
        "summer-10wk": { startDate: `${e}-05-17`, endDate: `${e}-07-24` },
      },
    },
  };
}

/** Asserts that validation fails with exactly this "path: message" error among its errors. */
function expectCalendarError(candidate: unknown, expected: string) {
  const result = validateAcademicCalendar(candidate);
  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.errors).toContain(expected);
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

describe("toValidInstant (strict input policy)", () => {
  it.each([
    ["2026-11-01T00:00:00Z", "2026-11-01T00:00:00.000Z"],
    ["2026-11-01T00:00Z", "2026-11-01T00:00:00.000Z"],
    ["2026-11-18T12:34:56.123456+00:00", "2026-11-18T12:34:56.123Z"],
    ["2026-11-18T12:34:56.123456789Z", "2026-11-18T12:34:56.123Z"],
    ["2026-08-17T00:00:00-04:00", "2026-08-17T04:00:00.000Z"],
  ])("accepts the timestamp %s", (input, expected) => {
    expect(toValidInstant(input)?.toISOString()).toBe(expected);
  });

  it.each([
    ["date-only string", "2026-11-01"],
    ["timestamp without offset", "2026-11-01T00:00"],
    ["timestamp without offset, with seconds", "2026-11-01T00:00:00"],
    ["space-separated Postgres text form", "2026-11-01 00:00:00+00"],
    ["offset without a colon", "2026-11-01T00:00:00+0000"],
    ["hour-only offset", "2026-11-01T00:00:00+00"],
    ["lowercase z", "2026-11-01T00:00:00z"],
    ["impossible day", "2026-02-30T00:00:00Z"],
    ["hour 24", "2026-11-01T24:00:00Z"],
    ["surrounding whitespace", " 2026-11-01T00:00:00Z"],
    ["text", "not a date"],
    ["empty string", ""],
  ])("rejects a %s", (_label, input) => {
    expect(toValidInstant(input)).toBeNull();
  });

  it("rejects invalid Dates, non-finite numbers, and missing values", () => {
    expect(toValidInstant(new Date(Number.NaN))).toBeNull();
    expect(toValidInstant(new Date("not a date"))).toBeNull();
    expect(toValidInstant(Number.NaN)).toBeNull();
    expect(toValidInstant(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toValidInstant(8.64e15 + 1)).toBeNull();
    expect(toValidInstant(null)).toBeNull();
    expect(toValidInstant(undefined)).toBeNull();
  });

  it("accepts Dates and epoch milliseconds, returning a copy", () => {
    const input = new Date("2026-11-18T00:00:00Z");
    const result = toValidInstant(input);
    expect(result?.getTime()).toBe(input.getTime());
    expect(result).not.toBe(input);
    expect(toValidInstant(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("treats the same instant written with different offsets identically", () => {
    expect(toValidInstant("2026-06-30T20:00:00-04:00")?.getTime()).toBe(
      toValidInstant("2026-07-01T00:00:00Z")?.getTime(),
    );
  });
});

describe("invalid dates are never assigned to the current period", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null or an empty list even though 'now' is a valid date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T15:00:00Z")); // inside FY2027 Q2, Fall 2026, 2026-11

    for (const invalid of [new Date(Number.NaN), "not a date", Number.NaN, "2026-11-18", null]) {
      expect(getFiscalPeriodsForDate(invalid)).toBeNull();
      expect(getCalendarMonthForDate(invalid)).toBeNull();
      expect(findAcademicPeriodsForDate(invalid)).toEqual([]);
      expect(getAcademicTermForDate(invalid)).toBeNull();
    }
    const fall2026 = getAcademicPeriodByKey("AY2026-2027-FALL")!;
    expect(isWithinPeriod(fall2026, new Date(Number.NaN))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fiscal periods
// ---------------------------------------------------------------------------

describe("fiscal periods (reuse deriveFiscalPeriod)", () => {
  it("builds FY2027 from July 1, 2026 to July 1, 2027 in UTC", () => {
    expect(getFiscalYearPeriod("FY2027")).toEqual({
      kind: "fiscal",
      granularity: "year",
      key: "FY2027",
      label: "Fiscal Year 2027",
      fiscalYear: "FY2027",
      startUtc: "2026-07-01T00:00:00.000Z",
      endExclusiveUtc: "2027-07-01T00:00:00.000Z",
    });
  });

  it("builds four contiguous quarters that exactly cover the fiscal year", () => {
    const quarters = getFiscalQuartersForYear("FY2027")!;
    expect(quarters.map((q) => [q.key, q.startUtc, q.endExclusiveUtc])).toEqual([
      ["FY2027-Q1", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
      ["FY2027-Q2", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
      ["FY2027-Q3", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z"],
      ["FY2027-Q4", "2027-04-01T00:00:00.000Z", "2027-07-01T00:00:00.000Z"],
    ]);
    expect(quarters.every((q) => q.parentKey === "FY2027" && q.fiscalYear === "FY2027")).toBe(true);
    expect(quarters[0].label).toBe("FY2027 Q1");
    const year = getFiscalYearPeriod("FY2027")!;
    expect(quarters[0].startUtc).toBe(year.startUtc);
    expect(quarters[3].endExclusiveUtc).toBe(year.endExclusiveUtc);
  });

  it("agrees with deriveFiscalPeriod at every UTC month start and month end from 2024 to 2028", () => {
    for (let year = 2024; year <= 2028; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const monthStart = new Date(Date.UTC(year, month, 1));
        for (const instant of [monthStart, new Date(monthStart.getTime() - 1)]) {
          const expected = deriveFiscalPeriod(instant);
          const result = getFiscalPeriodsForDate(instant)!;
          expect(result.year.fiscalYear).toBe(expected.fiscalYear);
          expect(result.quarter.fiscalQuarter).toBe(expected.fiscalQuarter);
          expect(isWithinPeriod(result.year, instant)).toBe(true);
          expect(isWithinPeriod(result.quarter, instant)).toBe(true);
        }
      }
    }
  });

  it("produces labels accepted by derivedMetadataSchema", () => {
    const { year, quarter } = getFiscalPeriodsForDate("2026-11-18T12:00:00Z")!;
    expect(derivedMetadataSchema.shape.fiscalYear.safeParse(year.fiscalYear).success).toBe(true);
    expect(derivedMetadataSchema.shape.fiscalQuarter.safeParse(quarter.fiscalQuarter).success).toBe(
      true,
    );
  });

  it("follows the UTC boundary, not the local one", () => {
    // 8 pm Eastern on June 30 is already July 1 in UTC.
    expect(getFiscalPeriodsForDate("2026-06-30T20:00:00-04:00")?.year.key).toBe("FY2027");
    expect(getFiscalPeriodsForDate("2026-06-30T23:59:59.999Z")?.year.key).toBe("FY2026");
  });

  it("applies the half-open rule at fiscal year and quarter edges", () => {
    expectHalfOpen(getFiscalYearPeriod("FY2027")!);
    getFiscalQuartersForYear("FY2027")!.forEach(expectHalfOpen);
    // A shared boundary belongs to the later period.
    expect(getFiscalPeriodsForDate("2026-10-01T00:00:00Z")?.quarter.key).toBe("FY2027-Q2");
  });

  it.each(["FY27", "fy2027", "FY2027 ", "2027", "", "FY20270"])(
    "rejects the malformed fiscal year key %j",
    (key) => {
      expect(getFiscalYearPeriod(key)).toBeNull();
      expect(getFiscalQuarterPeriod(key, "Q1")).toBeNull();
      expect(getFiscalQuartersForYear(key)).toBeNull();
    },
  );

  it.each(["Q0", "Q5", "q1", ""])("rejects the malformed quarter %j", (quarter) => {
    expect(getFiscalQuarterPeriod("FY2027", quarter)).toBeNull();
  });

  it("returns the same frozen object on repeated lookups", () => {
    const first = getFiscalYearPeriod("FY2030");
    expect(getFiscalYearPeriod("FY2030")).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(getFiscalQuarterPeriod("FY2030", "Q3"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calendar months
// ---------------------------------------------------------------------------

describe("calendar months (UTC)", () => {
  it("builds November 2026 with a stable key", () => {
    expect(getCalendarMonthPeriod("2026-11")).toEqual({
      kind: "calendar-month",
      granularity: "month",
      key: "2026-11",
      label: "November 2026",
      year: 2026,
      month: 11,
      startUtc: "2026-11-01T00:00:00.000Z",
      endExclusiveUtc: "2026-12-01T00:00:00.000Z",
    });
  });

  it("handles a leap February and the December-to-January year change", () => {
    expect(getCalendarMonthPeriod("2028-02")?.endExclusiveUtc).toBe("2028-03-01T00:00:00.000Z");
    expect(getCalendarMonthPeriod("2027-02")?.endExclusiveUtc).toBe("2027-03-01T00:00:00.000Z");
    expect(getCalendarMonthPeriod("2026-12")?.endExclusiveUtc).toBe("2027-01-01T00:00:00.000Z");
  });

  it("assigns instants by UTC month, with each boundary belonging to the later month", () => {
    expect(getCalendarMonthForDate("2026-11-30T23:59:59.999Z")?.key).toBe("2026-11");
    expect(getCalendarMonthForDate("2026-12-01T00:00:00Z")?.key).toBe("2026-12");
    // 8 pm Eastern on November 30 is already December in UTC.
    expect(getCalendarMonthForDate("2026-11-30T20:00:00-05:00")?.key).toBe("2026-12");
    expectHalfOpen(getCalendarMonthPeriod("2026-11")!);
  });

  it("round-trips keys", () => {
    for (const iso of ["2026-01-15T00:00:00Z", "2026-11-18T12:00:00Z", "2028-02-29T23:00:00Z"]) {
      const month = getCalendarMonthForDate(iso)!;
      expect(getCalendarMonthPeriod(month.key)).toEqual(month);
    }
  });

  it.each(["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "2026/11", "0999-01", ""])(
    "rejects the malformed key %j",
    (key) => {
      expect(getCalendarMonthPeriod(key)).toBeNull();
    },
  );

  it("formats keys with zero padding and rejects invalid parts", () => {
    expect(formatCalendarMonthKey(2026, 1)).toBe("2026-01");
    expect(formatCalendarMonthKey(2026, 12)).toBe("2026-12");
    expect(() => formatCalendarMonthKey(2026, 0)).toThrow(RangeError);
    expect(() => formatCalendarMonthKey(2026, 13)).toThrow(RangeError);
    expect(() => formatCalendarMonthKey(2026, 1.5)).toThrow(RangeError);
    expect(() => formatCalendarMonthKey(999, 1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Time zone conversion
// ---------------------------------------------------------------------------

describe("local midnight to UTC conversion", () => {
  it("uses the time zone's offset in effect at local midnight", () => {
    expect(zonedLocalMidnightToUtc("2026-08-17").toISOString()).toBe("2026-08-17T04:00:00.000Z");
    expect(zonedLocalMidnightToUtc("2027-01-11").toISOString()).toBe("2027-01-11T05:00:00.000Z");
  });

  it("handles the DST change days in America/New_York (changes happen at 02:00)", () => {
    // DST starts March 8, 2026: midnight is still standard time.
    expect(zonedLocalMidnightToUtc("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedLocalMidnightToUtc("2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // DST ends November 1, 2026: midnight is still daylight time.
    expect(zonedLocalMidnightToUtc("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedLocalMidnightToUtc("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("supports other time zones", () => {
    expect(zonedLocalMidnightToUtc("2026-01-01", "Asia/Kolkata").toISOString()).toBe(
      "2025-12-31T18:30:00.000Z",
    );
    expect(zonedLocalMidnightToUtc("2026-07-01", "UTC").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("rejects invalid local dates", () => {
    expect(() => zonedLocalMidnightToUtc("2026-02-30")).toThrow(RangeError);
    expect(() => zonedLocalMidnightToUtc("2026-2-3")).toThrow(RangeError);
    expect(() => zonedLocalMidnightToUtc("2026-11-01T00:00:00Z")).toThrow(RangeError);
  });

  it.each([
    ["2026-01-31", "2026-02-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"],
    ["2027-02-28", "2027-03-01"],
    ["2026-11-01", "2026-11-02"],
  ])("computes the day after %s as %s", (date, next) => {
    expect(nextLocalDate(date)).toBe(next);
  });

  it("validates local dates", () => {
    expect(isValidLocalDate("2028-02-29")).toBe(true);
    expect(isValidLocalDate("2027-02-29")).toBe(false);
    expect(isValidLocalDate("2026-11-31")).toBe(false);
    expect(isValidLocalDate("2026-11-1")).toBe(false);
    expect(() => nextLocalDate("2027-02-29")).toThrow(RangeError);
  });

  it("refuses to compute a day after the last four-digit date", () => {
    expect(nextLocalDate("9999-12-30")).toBe("9999-12-31");
    expect(() => nextLocalDate("9999-12-31")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Academic periods: official Howard calendar
// ---------------------------------------------------------------------------

describe("official Howard academic calendar", () => {
  it("passes validation", () => {
    expect(validateAcademicCalendar(HOWARD_ACADEMIC_CALENDAR)).toMatchObject({ ok: true });
  });

  it("cites only sources that contain each year's dates", () => {
    expect(
      HOWARD_ACADEMIC_CALENDAR.map((year) => [year.academicYear, year.sources.map((s) => s.url)]),
    ).toEqual([
      [
        "AY2025-2026",
        [
          "https://admission.howard.edu/sites/admission.howard.edu/files/2026-04/2025-2026%20Academic%20Calendar%204.22.26docx.pdf",
        ],
      ],
      ["AY2026-2027", ["https://howard.edu/calendars"]],
    ]);
  });

  it("cannot be changed at runtime, including nested objects", () => {
    const calendar = HOWARD_ACADEMIC_CALENDAR as unknown as EditableYear[];
    expect(Object.isFrozen(calendar)).toBe(true);
    expect(Object.isFrozen(calendar[0])).toBe(true);
    expect(Object.isFrozen(calendar[0].sources)).toBe(true);
    expect(Object.isFrozen(calendar[0].sources[0])).toBe(true);
    expect(Object.isFrozen(calendar[0].summer.sessions["summer-1"])).toBe(true);
    expect(() => {
      calendar[0].fall.endDate = "2025-12-31";
    }).toThrow(TypeError);
    expect(() => {
      calendar[0].summer.sessions["summer-1"].endDate = "2026-06-30";
    }).toThrow(TypeError);
    expect(() => {
      (calendar as unknown[]).push(makeYear(2027));
    }).toThrow(TypeError);
    expect(getAcademicPeriodByKey("AY2025-2026-FALL")?.localEndDate).toBe("2025-12-16");
  });

  it("converts every published date to the expected UTC bounds", () => {
    const rows = buildAcademicPeriods().map((p) => [p.key, p.startUtc, p.endExclusiveUtc]);
    expect(rows).toEqual([
      ["AY2025-2026-FALL", "2025-08-18T04:00:00.000Z", "2025-12-17T05:00:00.000Z"],
      ["AY2025-2026-SPRING", "2026-01-12T05:00:00.000Z", "2026-05-09T04:00:00.000Z"],
      // Summer Semester Ends Saturday July 25, 2026, the day after the sessions end.
      ["AY2025-2026-SUMMER", "2026-05-18T04:00:00.000Z", "2026-07-26T04:00:00.000Z"],
      // Summer Session I Ends Sunday June 21, 2026.
      ["AY2025-2026-SUMMER-1", "2026-05-18T04:00:00.000Z", "2026-06-22T04:00:00.000Z"],
      ["AY2025-2026-SUMMER-10WK", "2026-05-18T04:00:00.000Z", "2026-07-25T04:00:00.000Z"],
      // Summer Session II formal classes begin Sunday June 21, 2026.
      ["AY2025-2026-SUMMER-2", "2026-06-21T04:00:00.000Z", "2026-07-25T04:00:00.000Z"],
      ["AY2026-2027-FALL", "2026-08-17T04:00:00.000Z", "2026-12-17T05:00:00.000Z"],
      ["AY2026-2027-SPRING", "2027-01-11T05:00:00.000Z", "2027-05-08T04:00:00.000Z"],
      ["AY2026-2027-SUMMER", "2027-05-17T04:00:00.000Z", "2027-07-25T04:00:00.000Z"],
      ["AY2026-2027-SUMMER-1", "2027-05-17T04:00:00.000Z", "2027-06-21T04:00:00.000Z"],
      ["AY2026-2027-SUMMER-10WK", "2027-05-17T04:00:00.000Z", "2027-07-25T04:00:00.000Z"],
      ["AY2026-2027-SUMMER-2", "2027-06-21T04:00:00.000Z", "2027-07-25T04:00:00.000Z"],
    ]);
  });

  it("keeps the published local dates, labels, and parent links", () => {
    expect(getAcademicPeriodByKey("AY2026-2027-FALL")).toMatchObject({
      kind: "academic",
      granularity: "term",
      term: "fall",
      label: "Fall 2026",
      academicYear: "AY2026-2027",
      timeZone: ACADEMIC_TIME_ZONE,
      localStartDate: "2026-08-17",
      localEndDate: "2026-12-16",
      sessionKeys: [],
    });
    expect(getAcademicPeriodByKey("AY2025-2026-SUMMER")).toMatchObject({
      label: "Summer 2026",
      academicYear: "AY2025-2026",
      localStartDate: "2026-05-18",
      localEndDate: "2026-07-25",
      sessionKeys: ["AY2025-2026-SUMMER-1", "AY2025-2026-SUMMER-2", "AY2025-2026-SUMMER-10WK"],
    });
    expect(getAcademicPeriodByKey("AY2025-2026-SUMMER-1")).toMatchObject({
      label: "Summer Session I 2026",
      localStartDate: "2026-05-18",
      localEndDate: "2026-06-21",
    });
    expect(getAcademicPeriodByKey("AY2025-2026-SUMMER-2")).toMatchObject({
      label: "Summer Session II 2026",
      localStartDate: "2026-06-21",
      localEndDate: "2026-07-24",
    });
    expect(getAcademicPeriodByKey("AY2025-2026-SUMMER-10WK")).toMatchObject({
      granularity: "session",
      term: "summer",
      session: "summer-10wk",
      label: "Summer 10-Week Session 2026",
      parentKey: "AY2025-2026-SUMMER",
      localStartDate: "2026-05-18",
      localEndDate: "2026-07-24",
    });
    expect(getAcademicPeriodByKey("AY2026-2027-SUMMER")).toMatchObject({
      localStartDate: "2027-05-17",
      localEndDate: "2027-07-24",
    });
    expect(getAcademicPeriodByKey("AY2030-2031-FALL")).toBeNull();
  });

  it("assigns Summer to the academic year that began the previous fall", () => {
    expect(getAcademicTermForDate("2026-06-01T12:00:00Z")?.key).toBe("AY2025-2026-SUMMER");
    expect(getAcademicTermForDate("2027-06-01T12:00:00Z")?.key).toBe("AY2026-2027-SUMMER");
  });

  it.each([
    ["mid-Fall", "2026-10-15T12:00:00Z", "AY2026-2027-FALL"],
    ["mid-Spring", "2027-03-01T12:00:00Z", "AY2026-2027-SPRING"],
    ["mid-Spring 2026", "2026-02-15T12:00:00Z", "AY2025-2026-SPRING"],
  ])("finds the term for a %s date", (_label, iso, key) => {
    expect(keys(findAcademicPeriodsForDate(iso))).toEqual([key]);
    expect(getAcademicTermForDate(iso)?.key).toBe(key);
  });

  it("returns the Summer term and every overlapping session, in the documented order", () => {
    // Session I and the 10-Week Session overlap; same start, so Session I is listed first.
    expect(keys(findAcademicPeriodsForDate("2026-06-01T16:00:00Z"))).toEqual([
      "AY2025-2026-SUMMER",
      "AY2025-2026-SUMMER-1",
      "AY2025-2026-SUMMER-10WK",
    ]);
    // Sunday June 21, 2026: Session I's last day and Session II's first day, inside 10-Week.
    expect(keys(findAcademicPeriodsForDate("2026-06-21T16:00:00Z"))).toEqual([
      "AY2025-2026-SUMMER",
      "AY2025-2026-SUMMER-1",
      "AY2025-2026-SUMMER-10WK",
      "AY2025-2026-SUMMER-2",
    ]);
    // Session II and the 10-Week Session overlap; 10-Week started earlier.
    expect(keys(findAcademicPeriodsForDate("2026-07-10T16:00:00Z"))).toEqual([
      "AY2025-2026-SUMMER",
      "AY2025-2026-SUMMER-10WK",
      "AY2025-2026-SUMMER-2",
    ]);
    expect(getAcademicTermForDate("2026-06-21T16:00:00Z")?.key).toBe("AY2025-2026-SUMMER");
  });

  it("keeps the Summer semester end distinct from the session end dates", () => {
    // Saturday July 25, 2026: the sessions have ended, but the Summer semester has not.
    expect(keys(findAcademicPeriodsForDate("2026-07-25T16:00:00Z"))).toEqual([
      "AY2025-2026-SUMMER",
    ]);
    expect(keys(findAcademicPeriodsForDate("2026-07-24T23:59:59.999-04:00"))).toEqual([
      "AY2025-2026-SUMMER",
      "AY2025-2026-SUMMER-10WK",
      "AY2025-2026-SUMMER-2",
    ]);
    // Midnight Eastern after July 25 is outside every Summer period.
    expect(findAcademicPeriodsForDate("2026-07-25T23:59:59.999-04:00")).toHaveLength(1);
    expect(findAcademicPeriodsForDate("2026-07-26T00:00:00-04:00")).toEqual([]);
  });

  it("gives a shared session boundary to the later session only", () => {
    // In 2027, Session I ends June 20 and Session II starts June 21.
    const boundary = "2027-06-21T04:00:00.000Z";
    expect(keys(findAcademicPeriodsForDate(boundary))).toEqual([
      "AY2026-2027-SUMMER",
      "AY2026-2027-SUMMER-10WK",
      "AY2026-2027-SUMMER-2",
    ]);
    expect(keys(findAcademicPeriodsForDate(minus1ms(boundary)))).toEqual([
      "AY2026-2027-SUMMER",
      "AY2026-2027-SUMMER-1",
      "AY2026-2027-SUMMER-10WK",
    ]);
  });

  it("includes the whole published end date in Eastern time", () => {
    // 11:59:59.999 pm Eastern (EST) on December 16, 2026 is in Fall; midnight is not.
    expect(getAcademicTermForDate("2026-12-16T23:59:59.999-05:00")?.key).toBe("AY2026-2027-FALL");
    expect(getAcademicTermForDate("2026-12-17T00:00:00-05:00")).toBeNull();
    // 9 pm Eastern on August 16, 2026 is August 17 in UTC but still before Fall starts.
    expect(getAcademicTermForDate("2026-08-16T21:00:00-04:00")).toBeNull();
    expect(getAcademicTermForDate("2026-08-17T00:00:00-04:00")?.key).toBe("AY2026-2027-FALL");
  });

  it("applies the half-open rule to every official period", () => {
    buildAcademicPeriods().forEach(expectHalfOpen);
  });

  it.each([
    ["winter break", "2025-12-25T12:00:00Z"],
    ["between Spring and Summer", "2026-05-12T12:00:00Z"],
    ["between Summer and Fall", "2026-08-01T12:00:00Z"],
    ["before the calendar data", "2024-10-01T12:00:00Z"],
    ["after the calendar data", "2027-09-01T12:00:00Z"],
  ])("returns no academic period during %s", (_label, iso) => {
    expect(findAcademicPeriodsForDate(iso)).toEqual([]);
    expect(getAcademicTermForDate(iso)).toBeNull();
  });

  it("never lets terms overlap", () => {
    const terms = buildAcademicPeriods().filter((p) => p.granularity === "term");
    for (let i = 1; i < terms.length; i += 1) {
      expect(ms(terms[i - 1].endExclusiveUtc)).toBeLessThanOrEqual(ms(terms[i].startUtc));
    }
  });

  it("returns frozen periods, reused by reference for the deeply frozen default calendar", () => {
    const periods = buildAcademicPeriods();
    expect(buildAcademicPeriods()).toBe(periods);
    expect(buildAcademicPeriods(HOWARD_ACADEMIC_CALENDAR)).toBe(periods);
    expect(Object.isFrozen(periods)).toBe(true);
    expect(periods.every((p) => Object.isFrozen(p))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Academic periods: synthetic fixture edge cases
// ---------------------------------------------------------------------------

describe("academic periods built from a fixture calendar", () => {
  it("ends a term correctly on DST change days", () => {
    // Fall ends Nov 1, 2026 (DST ends that day): next local midnight is EST.
    expect(getAcademicPeriodByKey("AY2026-2027-FALL", FIXTURE)?.endExclusiveUtc).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    // Spring ends Mar 14, 2027 (DST starts that day): next local midnight is EDT.
    expect(getAcademicPeriodByKey("AY2026-2027-SPRING", FIXTURE)?.endExclusiveUtc).toBe(
      "2027-03-15T04:00:00.000Z",
    );
    // A term spanning the March DST change starts in EST.
    expect(getAcademicPeriodByKey("AY2026-2027-SPRING", FIXTURE)?.startUtc).toBe(
      "2027-01-11T05:00:00.000Z",
    );
  });

  it("uses official Summer term dates when they are given", () => {
    expect(getAcademicPeriodByKey("AY2026-2027-SUMMER", FIXTURE)).toMatchObject({
      localStartDate: "2027-05-10",
      localEndDate: "2027-07-31",
      startUtc: "2027-05-10T04:00:00.000Z",
      endExclusiveUtc: "2027-08-01T04:00:00.000Z",
    });
  });

  it("falls back to the sessions independently for a missing Summer start or end", () => {
    const endOnly = [
      editableYear((y) => {
        delete y.summer.startDate;
      }),
    ] as AcademicCalendar;
    expect(getAcademicPeriodByKey("AY2026-2027-SUMMER", endOnly)).toMatchObject({
      localStartDate: "2027-05-17", // earliest session start
      localEndDate: "2027-07-31", // official end
    });
    const startOnly = [
      editableYear((y) => {
        delete y.summer.endDate;
      }),
    ] as AcademicCalendar;
    expect(getAcademicPeriodByKey("AY2026-2027-SUMMER", startOnly)).toMatchObject({
      localStartDate: "2027-05-10", // official start
      localEndDate: "2027-07-15", // latest session end
    });
  });

  it("returns only the Summer term between sessions", () => {
    expect(keys(findAcademicPeriodsForDate("2027-06-20T12:00:00Z", FIXTURE))).toEqual([
      "AY2026-2027-SUMMER",
    ]);
    expect(keys(findAcademicPeriodsForDate("2027-05-27T12:00:00Z", FIXTURE))).toEqual([
      "AY2026-2027-SUMMER",
      "AY2026-2027-SUMMER-1",
      "AY2026-2027-SUMMER-10WK",
    ]);
  });

  it("does not use the default calendar when a calendar is passed", () => {
    expect(getAcademicTermForDate("2025-10-01T12:00:00Z", FIXTURE)).toBeNull();
    expect(getAcademicTermForDate("2025-10-01T12:00:00Z")?.key).toBe("AY2025-2026-FALL");
  });

  it("supports the first and last supported academic years", () => {
    expect(buildAcademicPeriods([makeYear(1000)])).toHaveLength(6);
    expect(buildAcademicPeriods([makeYear(9997)])).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Academic period cache
// ---------------------------------------------------------------------------

describe("academic period cache with custom calendars", () => {
  it("reuses periods for a stable, unchanged calendar reference", () => {
    const calendar = [editableYear()] as AcademicCalendar;
    const first = buildAcademicPeriods(calendar);
    expect(buildAcademicPeriods(calendar)).toBe(first);
    expect(findAcademicPeriodsForDate("2026-10-01T12:00:00Z", calendar)[0]).toBe(first[0]);
  });

  it("rebuilds after a nested date is changed in place", () => {
    const year = editableYear();
    const calendar = [year] as AcademicCalendar;
    const first = buildAcademicPeriods(calendar);
    expect(getAcademicTermForDate("2026-11-10T12:00:00Z", calendar)).toBeNull(); // Fall ends Nov 1

    year.fall.endDate = "2026-12-16";
    const second = buildAcademicPeriods(calendar);
    expect(second).not.toBe(first);
    expect(getAcademicTermForDate("2026-11-10T12:00:00Z", calendar)?.key).toBe("AY2026-2027-FALL");
    expect(buildAcademicPeriods(calendar)).toBe(second);
  });

  it("picks up a year added to the calendar array", () => {
    const calendar: AcademicCalendarYear[] = [editableYear()];
    expect(getAcademicPeriodByKey("AY2025-2026-FALL", calendar)).toBeNull();
    calendar.unshift(makeYear(2025));
    expect(getAcademicPeriodByKey("AY2025-2026-FALL", calendar)?.localStartDate).toBe("2025-08-17");
  });

  it("throws instead of serving stale periods when a calendar becomes invalid", () => {
    const year = editableYear();
    const calendar = [year] as AcademicCalendar;
    buildAcademicPeriods(calendar);
    year.fall.endDate = "2026-08-01";
    expect(() => buildAcademicPeriods(calendar)).toThrow(
      "Invalid academic calendar: 0.fall.endDate: startDate must be on or before endDate",
    );
  });
});

// ---------------------------------------------------------------------------
// Academic calendar validation
// ---------------------------------------------------------------------------

describe("academic calendar validation", () => {
  it("accepts the fixture", () => {
    expect(validateAcademicCalendar(FIXTURE)).toMatchObject({ ok: true });
  });

  it("accepts a Fall term that ends in January of the end year", () => {
    const result = validateAcademicCalendar(
      withYear((y) => {
        y.fall.endDate = "2027-01-05";
      }),
    );
    expect(result.ok).toBe(true);
  });

  it.each<[string, (year: EditableYear) => void, string]>([
    [
      "start after end",
      (y) => {
        y.fall.endDate = "2026-08-01";
      },
      "0.fall.endDate: startDate must be on or before endDate",
    ],
    [
      "an impossible date",
      (y) => {
        y.spring.startDate = "2027-02-30";
      },
      "0.spring.startDate: must be a real calendar date in YYYY-MM-DD format",
    ],
    [
      "Fall overlapping Spring",
      (y) => {
        y.fall.endDate = "2027-01-11";
      },
      "0.spring.startDate: Spring must start after Fall ends",
    ],
    [
      "a session outside the Summer term",
      (y) => {
        y.summer.sessions["summer-2"].endDate = "2027-08-15";
      },
      "0.summer.sessions.summer-2: session must fall within the Summer term",
    ],
    [
      "Summer overlapping Spring",
      (y) => {
        y.spring.endDate = "2027-05-12";
      },
      "0.summer: Summer must start after Spring ends",
    ],
    [
      "a missing source",
      (y) => {
        y.sources = [];
      },
      "0.sources: at least one official source is required",
    ],
    [
      "a non-https source",
      (y) => {
        y.sources = [{ url: "http://example.edu", publishedBy: "X", retrievedOn: "2026-11-18" }];
      },
      "0.sources.0.url: must be an https URL",
    ],
    [
      "a mismatched academic year",
      (y) => {
        y.academicYear = "AY2026-2028";
      },
      "0.academicYear: end year must be the year after the start year",
    ],
    [
      "Fall in the wrong year",
      (y) => {
        y.academicYear = "AY2025-2026";
      },
      "0.fall.startDate: must be in 2025 for AY2025-2026",
    ],
    [
      "a missing Summer session",
      (y) => {
        delete (y.summer.sessions as Partial<typeof y.summer.sessions>)["summer-10wk"];
      },
      "0.summer.sessions.summer-10wk: Required",
    ],
    [
      "an unknown field",
      (y) => {
        y.winter = {};
      },
      "0: Unrecognized key(s) in object: 'winter'",
    ],
    [
      "a Summer start after the Summer end",
      (y) => {
        y.summer.startDate = "2027-08-01";
      },
      "0.summer.endDate: startDate must be on or before endDate",
    ],
  ])("rejects %s", (_label, change, expected) => {
    expectCalendarError(withYear(change), expected);
  });

  describe("Summer session order", () => {
    it.each<[string, (year: EditableYear) => void, string]>([
      [
        "Session II starting before Session I",
        (y) => {
          y.summer.sessions["summer-2"].startDate = "2027-05-16";
        },
        "0.summer.sessions.summer-2.startDate: Summer Session II must start after Summer Session I starts",
      ],
      [
        "Session II starting the same day as Session I",
        (y) => {
          y.summer.sessions["summer-2"].startDate = "2027-05-17";
        },
        "0.summer.sessions.summer-2.startDate: Summer Session II must start after Summer Session I starts",
      ],
      [
        "Session I ending after Session II ends",
        (y) => {
          y.summer.sessions["summer-1"].endDate = "2027-07-20";
        },
        "0.summer.sessions.summer-1.endDate: Summer Session I must end before Summer Session II ends",
      ],
      [
        "the 10-Week Session starting with Session II",
        (y) => {
          y.summer.sessions["summer-10wk"] = { startDate: "2027-07-01", endDate: "2027-07-20" };
        },
        "0.summer.sessions.summer-10wk.startDate: Summer 10-Week Session must start before Summer Session II starts",
      ],
      [
        "the 10-Week Session ending before Session I ends",
        (y) => {
          y.summer.sessions["summer-10wk"] = { startDate: "2027-05-17", endDate: "2027-05-30" };
        },
        "0.summer.sessions.summer-10wk.endDate: Summer 10-Week Session must end after Summer Session I ends",
      ],
    ])("rejects %s", (_label, change, expected) => {
      expectCalendarError(withYear(change), expected);
    });

    it("accepts overlapping sessions that keep their order", () => {
      expect(validateAcademicCalendar(HOWARD_ACADEMIC_CALENDAR).ok).toBe(true); // June 21, 2026 overlap
    });
  });

  describe("Summer dates and the academic year", () => {
    it.each<[string, (year: EditableYear) => void, string]>([
      [
        "a session running into the next year in the final calendar year",
        (y) => {
          delete y.summer.startDate;
          delete y.summer.endDate;
          y.summer.sessions["summer-2"].endDate = "2028-07-15";
          y.summer.sessions["summer-10wk"].endDate = "2028-07-20";
        },
        "0.summer.sessions.summer-2.endDate: must be in 2027 for AY2026-2027",
      ],
      [
        "a Summer semester end in the next year",
        (y) => {
          y.summer.endDate = "2028-07-31";
        },
        "0.summer.endDate: must be in 2027 for AY2026-2027",
      ],
      [
        "a Summer semester start in the start year",
        (y) => {
          y.summer.startDate = "2026-12-20";
        },
        "0.summer.startDate: must be in 2027 for AY2026-2027",
      ],
      [
        "a Spring end in the next year",
        (y) => {
          y.spring.endDate = "2028-03-14";
        },
        "0.spring.endDate: must be in 2027 for AY2026-2027",
      ],
      [
        "a Fall end after the end year",
        (y) => {
          y.fall.endDate = "2028-01-05";
        },
        "0.fall.endDate: must be in 2026 or 2027 for AY2026-2027",
      ],
    ])("rejects %s", (_label, change, expected) => {
      expectCalendarError(withYear(change), expected);
    });
  });

  describe("supported years", () => {
    it.each([
      [999, "AY0999-1000"],
      [9998, "AY9998-9999"],
    ])("rejects start year %i (%s) before converting any date", (startYear, academicYear) => {
      const message = `0.academicYear: only AY1000-1001 through AY9997-9998 are supported`;
      expectCalendarError([makeYear(startYear)], message);
      // buildAcademicPeriods reports the validation error, not a time zone failure.
      expect(() => buildAcademicPeriods([makeYear(startYear)])).toThrow(
        `Invalid academic calendar: ${message}`,
      );
      expect(academicYear).toBe(makeYear(startYear).academicYear);
    });
  });

  it("rejects duplicate and overlapping academic years", () => {
    expectCalendarError(
      [FIXTURE_YEAR, FIXTURE_YEAR],
      "1.academicYear: duplicate academic year AY2026-2027",
    );
    expectCalendarError(
      [
        ...HOWARD_ACADEMIC_CALENDAR.slice(0, 1),
        { ...FIXTURE_YEAR, fall: { startDate: "2026-07-20", endDate: "2026-11-01" } },
      ],
      "1.fall.startDate: AY2026-2027 overlaps AY2025-2026",
    );
  });

  it("rejects an empty calendar", () => {
    expectCalendarError([], "calendar: at least one academic year is required");
  });
});

// ---------------------------------------------------------------------------
// Academic calendar coverage (F18.2)
// ---------------------------------------------------------------------------

describe("academic calendar coverage", () => {
  it("spans the official calendar from the first Fall start to the last Summer end", () => {
    expect(getAcademicCalendarCoverage()).toEqual({
      timeZone: ACADEMIC_TIME_ZONE,
      startUtc: "2025-08-18T04:00:00.000Z",
      endExclusiveUtc: "2027-07-25T04:00:00.000Z",
      localStartDate: "2025-08-18",
      localEndDate: "2027-07-24",
      firstAcademicYear: "AY2025-2026",
      lastAcademicYear: "AY2026-2027",
    });
  });

  it("is frozen and reused for the deeply frozen default calendar", () => {
    const coverage = getAcademicCalendarCoverage();
    expect(Object.isFrozen(coverage)).toBe(true);
    expect(getAcademicCalendarCoverage(HOWARD_ACADEMIC_CALENDAR)).toBe(coverage);
  });

  it("does not depend on the order of years in the calendar array", () => {
    expect(getAcademicCalendarCoverage([...HOWARD_ACADEMIC_CALENDAR].reverse())).toEqual(
      getAcademicCalendarCoverage(),
    );
    expect(getAcademicCalendarCoverage([makeYear(2027), makeYear(2025), makeYear(2026)])).toEqual(
      getAcademicCalendarCoverage([makeYear(2025), makeYear(2026), makeYear(2027)]),
    );
    expect(
      getAcademicCalendarCoverage([makeYear(2027), makeYear(2025), makeYear(2026)]),
    ).toMatchObject({
      localStartDate: "2025-08-17",
      localEndDate: "2028-07-24",
      firstAcademicYear: "AY2025-2026",
      lastAcademicYear: "AY2027-2028",
    });
  });

  it("uses an explicit Summer end date and supports a single-year calendar", () => {
    expect(getAcademicCalendarCoverage(FIXTURE)).toMatchObject({
      startUtc: "2026-08-17T04:00:00.000Z",
      endExclusiveUtc: "2027-08-01T04:00:00.000Z",
      localStartDate: "2026-08-17",
      localEndDate: "2027-07-31",
      firstAcademicYear: "AY2026-2027",
      lastAcademicYear: "AY2026-2027",
    });
  });

  it("rejects calendars with a missing academic year between covered years", () => {
    expect(() => getAcademicCalendarCoverage([makeYear(2025), makeYear(2027)])).toThrow(
      "Academic calendar years must be consecutive: AY2026-2027 is missing between " +
        "AY2025-2026 and AY2027-2028",
    );
  });

  it("throws for an invalid calendar", () => {
    expect(() => getAcademicCalendarCoverage([])).toThrow(
      "Invalid academic calendar: calendar: at least one academic year is required",
    );
  });

  it("recomputes after a non-frozen calendar is changed in place", () => {
    const year = editableYear();
    const calendar = [year] as AcademicCalendar;
    const first = getAcademicCalendarCoverage(calendar);
    expect(getAcademicCalendarCoverage(calendar)).toBe(first);

    year.summer.endDate = "2027-08-10";
    const second = getAcademicCalendarCoverage(calendar);
    expect(second).not.toBe(first);
    expect(second.localEndDate).toBe("2027-08-10");
    expect(second.endExclusiveUtc).toBe("2027-08-11T04:00:00.000Z");
  });
});

describe("academic coverage status", () => {
  const start = "2025-08-18T04:00:00.000Z";
  const endExclusive = "2027-07-25T04:00:00.000Z";

  it("lists every status", () => {
    expect(ACADEMIC_COVERAGE_STATUSES).toEqual([
      "invalid-date",
      "before-coverage",
      "in-term",
      "between-terms",
      "after-coverage",
    ]);
  });

  it("reports invalid input without throwing, even for an invalid calendar", () => {
    for (const input of [
      null,
      undefined,
      Number.NaN,
      new Date(Number.NaN),
      "2026-01-01",
      "2026-01-01T00:00:00",
    ]) {
      expect(getAcademicCoverageStatus(input)).toBe("invalid-date");
    }
    expect(getAcademicCoverageStatus(null, [])).toBe("invalid-date");
    expect(() => getAcademicCoverageStatus(start, [])).toThrow("Invalid academic calendar");
  });

  it("applies the half-open rule at both coverage edges", () => {
    expect(getAcademicCoverageStatus(minus1ms(start))).toBe("before-coverage");
    expect(getAcademicCoverageStatus(start)).toBe("in-term");
    expect(getAcademicCoverageStatus(minus1ms(endExclusive))).toBe("in-term");
    expect(getAcademicCoverageStatus(endExclusive)).toBe("after-coverage");
    expect(getAcademicCoverageStatus("2028-01-15T12:00:00Z")).toBe("after-coverage");
    expect(getAcademicCoverageStatus("2025-07-01T12:00:00Z")).toBe("before-coverage");
  });

  it("reports breaks inside the covered span as between terms", () => {
    expect(getAcademicCoverageStatus("2025-12-20T12:00:00Z")).toBe("between-terms"); // winter break
    expect(getAcademicCoverageStatus("2026-05-12T12:00:00Z")).toBe("between-terms"); // Spring to Summer
    expect(getAcademicCoverageStatus("2026-08-01T12:00:00Z")).toBe("between-terms"); // Summer to Fall
  });

  it("uses Eastern time term edges", () => {
    // Fall 2025 ends Tuesday December 16; the next local midnight is 05:00Z (EST).
    expect(getAcademicCoverageStatus("2025-12-17T04:59:59.999Z")).toBe("in-term");
    expect(getAcademicCoverageStatus("2025-12-17T05:00:00.000Z")).toBe("between-terms");
  });

  it("agrees with getAcademicTermForDate and the coverage bounds at every sampled instant", () => {
    const step = 6 * 60 * 60 * 1000;
    for (let t = ms("2025-07-01T00:00:00Z"); t < ms("2027-09-01T00:00:00Z"); t += step) {
      const status = getAcademicCoverageStatus(t);
      const expected =
        t < ms(start)
          ? "before-coverage"
          : t >= ms(endExclusive)
            ? "after-coverage"
            : getAcademicTermForDate(t)
              ? "in-term"
              : "between-terms";
      expect(status, new Date(t).toISOString()).toBe(expected);
    }
  });

  it("uses the calendar that is passed", () => {
    expect(getAcademicCoverageStatus("2025-10-01T12:00:00Z", FIXTURE)).toBe("before-coverage");
    expect(getAcademicCoverageStatus("2027-07-28T12:00:00Z", FIXTURE)).toBe("in-term");
    expect(getAcademicCoverageStatus("2027-07-28T12:00:00Z")).toBe("after-coverage");
  });
});
