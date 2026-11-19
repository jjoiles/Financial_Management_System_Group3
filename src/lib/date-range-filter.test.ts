import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_DATE_RANGE_ERROR_CODES,
  CUSTOM_DATE_RANGE_TIME_ZONE,
  filterByPeriod,
  validateCustomDateRange,
  type CustomDateRange,
  type CustomDateRangeError,
  type CustomDateRangeInput,
} from "./date-range-filter";
import {
  REPORTING_PERIOD_KINDS,
  REPORTING_PERIOD_TIME_ZONES,
  getAcademicCalendarCoverage,
  getAcademicPeriodByKey,
  getAcademicTermForDate,
  getCalendarMonthForDate,
  getCalendarMonthPeriod,
  getFiscalPeriodsForDate,
  getFiscalQuarterPeriod,
  getFiscalYearPeriod,
  isWithinPeriod,
  type PeriodBounds,
} from "./reporting-periods";
import { INSTITUTION_TIME_ZONE, localDateRangeToUtcBounds } from "./time-zones";

/**
 * F18.4 cross-period filtering and custom date ranges. Standard period bounds
 * always come from the F18.1 period APIs, never from hardcoded values.
 */

const NY = "America/New_York";
const HOUR_MS = 3_600_000;

type Row = { id: string; createdAt?: unknown; submittedAt?: string };

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
const ms = (iso: string) => Date.parse(iso);
const shift = (iso: string, deltaMs: number) => new Date(ms(iso) + deltaMs).toISOString();

/** Returns the validated range, failing the test with the errors otherwise. */
function range(startDate: string, endDate: string, timeZone: string = NY): CustomDateRange {
  const result = validateCustomDateRange({ startDate, endDate, timeZone });
  if (!result.ok) throw new Error(`Expected a valid range: ${JSON.stringify(result.errors)}`);
  return result.range;
}

/** Returns the errors, failing the test if validation succeeded. */
function errorsFor(
  input: CustomDateRangeInput | null | undefined,
): readonly CustomDateRangeError[] {
  const result = validateCustomDateRange(input);
  if (result.ok) throw new Error(`Expected validation to fail: ${JSON.stringify(result.range)}`);
  return result.errors;
}

const codes = (errors: readonly CustomDateRangeError[]) =>
  errors.map(({ field, code }) => `${field}:${code}`);

/** Non-null period lookup, so a wrong key fails loudly instead of filtering nothing. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Missing period: ${what}`);
  return value;
}

/** Rows one millisecond either side of each edge of `bounds`. */
function edgeRows(bounds: PeriodBounds): Row[] {
  return [
    { id: "start-1ms", createdAt: shift(bounds.startUtc, -1) },
    { id: "start", createdAt: bounds.startUtc },
    { id: "end-1ms", createdAt: shift(bounds.endExclusiveUtc, -1) },
    { id: "end", createdAt: bounds.endExclusiveUtc },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Module boundaries and policy
// ---------------------------------------------------------------------------

describe("module boundaries and time zone policy", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const importSpecifiers = (source: string) =>
    [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);

  it("imports only time-zones.ts and reporting-periods.ts, and nothing imports it back", () => {
    const source = read("./date-range-filter.ts");
    expect(importSpecifiers(source).sort()).toEqual([
      "@/lib/reporting-periods",
      "@/lib/time-zones",
    ]);
    for (const file of [
      "./time-zones.ts",
      "./reporting-periods.ts",
      "./reporting-period-config.ts",
    ]) {
      expect(read(file)).not.toMatch(/date-range-filter/);
    }
  });

  it("never imports the viewer's time zone helper", () => {
    const imports = read("./date-range-filter.ts").match(/^import[\s\S]*?;$/gm) ?? [];
    expect(imports.join("\n")).not.toMatch(/resolveViewerTimeZone/);
  });

  it("fixes custom ranges to the institutional zone", () => {
    expect(CUSTOM_DATE_RANGE_TIME_ZONE).toBe(INSTITUTION_TIME_ZONE);
    expect(CUSTOM_DATE_RANGE_TIME_ZONE).toBe("America/New_York");
  });

  it("does not add a custom reporting-period kind", () => {
    expect(REPORTING_PERIOD_KINDS).toEqual(["fiscal", "academic", "calendar-month"]);
    expect(Object.keys(REPORTING_PERIOD_TIME_ZONES).sort()).toEqual(
      ["academic", "calendar-month", "fiscal"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateCustomDateRange: valid ranges", () => {
  it("returns frozen bounds equal to localDateRangeToUtcBounds()", () => {
    const result = validateCustomDateRange({
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      timeZone: CUSTOM_DATE_RANGE_TIME_ZONE,
    });
    expect(result).toEqual({
      ok: true,
      range: {
        kind: "custom",
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        timeZone: NY,
        ...localDateRangeToUtcBounds({ startDate: "2026-01-01", endDate: "2026-03-31" }, NY),
        key: "custom:2026-01-01..2026-03-31@America/New_York",
        label: "January 1, 2026 – March 31, 2026 (America/New_York)",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok && Object.isFrozen(result.range)).toBe(true);
  });

  it("accepts a single-day range", () => {
    const day = range("2026-11-18", "2026-11-18");
    expect(day.startUtc).toBe("2026-11-18T05:00:00.000Z");
    expect(day.endExclusiveUtc).toBe("2026-11-19T05:00:00.000Z");
    expect(day.label).toBe("November 18, 2026 (America/New_York)");
    expect(day.key).toBe("custom:2026-11-18..2026-11-18@America/New_York");
  });

  it("allows future dates and long ranges", () => {
    expect(range("2100-01-01", "2100-12-31").startUtc).toBe("2100-01-01T05:00:00.000Z");
    expect(range("1900-01-01", "2999-12-31").endExclusiveUtc).toBe("3000-01-01T05:00:00.000Z");
  });

  it("keeps the explicit zone it is given", () => {
    const utc = range("2026-08-01", "2026-08-31", "UTC");
    expect(utc.timeZone).toBe("UTC");
    expect(utc.startUtc).toBe("2026-08-01T00:00:00.000Z");
    expect(utc.key).toBe("custom:2026-08-01..2026-08-31@UTC");
  });

  it("does not change its input", () => {
    const input = Object.freeze({ startDate: "2026-01-01", endDate: "2026-01-02", timeZone: NY });
    expect(validateCustomDateRange(input).ok).toBe(true);
    expect(input).toEqual({ startDate: "2026-01-01", endDate: "2026-01-02", timeZone: NY });
  });
});

describe("validateCustomDateRange: invalid input", () => {
  const VALID = { startDate: "2026-01-01", endDate: "2026-01-31", timeZone: NY } as const;

  it("lists every error code", () => {
    expect(CUSTOM_DATE_RANGE_ERROR_CODES).toEqual([
      "required",
      "not-a-string",
      "invalid-format",
      "invalid-date",
      "unsupported-time-zone",
      "start-after-end",
      "nonexistent-local-midnight",
      "unsupported-end-date",
    ]);
  });

  it.each([
    ["missing input (undefined)", undefined],
    ["missing input (null)", null],
    ["an empty object", {}],
    ["null values", { startDate: null, endDate: null, timeZone: null }],
    ["empty strings", { startDate: "", endDate: "", timeZone: "" }],
    ["whitespace-only strings", { startDate: "  ", endDate: "\t", timeZone: " \n " }],
  ])("reports every field as required for %s", (_label, input) => {
    expect(codes(errorsFor(input))).toEqual([
      "startDate:required",
      "endDate:required",
      "timeZone:required",
    ]);
  });

  it.each(["startDate", "endDate", "timeZone"] as const)(
    "reports a missing %s on its own",
    (field) => {
      const input: Record<string, unknown> = { ...VALID };
      delete input[field];
      expect(codes(errorsFor(input))).toEqual([`${field}:required`]);
    },
  );

  it.each([
    ["a number", 20260101],
    ["a Date", new Date("2026-01-01T00:00:00Z")],
    ["an object", { year: 2026 }],
    ["an array", ["2026-01-01"]],
    ["a boolean", true],
    ["a symbol", Symbol("2026-01-01")],
    ["a bigint", 20260101n],
  ])("rejects %s as not-a-string for every field", (_label, value) => {
    expect(codes(errorsFor({ startDate: value, endDate: value, timeZone: value }))).toEqual([
      "startDate:not-a-string",
      "endDate:not-a-string",
      "timeZone:not-a-string",
    ]);
  });

  it.each([
    "2026-1-05",
    "2026-01-5",
    "26-01-05",
    "2026/01/05",
    "01/05/2026",
    "20260105",
    "2026-01-05T00:00:00Z",
    "2026-01-05T00:00",
    " 2026-01-05",
    "2026-01-05 ",
    "+02026-01-05",
    "January 5, 2026",
    "2026-01-05\n",
  ])("rejects the malformed date %j", (value) => {
    expect(codes(errorsFor({ ...VALID, startDate: value }))).toEqual(["startDate:invalid-format"]);
    expect(codes(errorsFor({ ...VALID, endDate: value }))).toEqual(["endDate:invalid-format"]);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00"])(
    "rejects the impossible date %s",
    (value) => {
      expect(codes(errorsFor({ ...VALID, startDate: value }))).toEqual(["startDate:invalid-date"]);
      expect(codes(errorsFor({ ...VALID, endDate: value }))).toEqual(["endDate:invalid-date"]);
    },
  );

  it.each(["Mars/Olympus", "America/New York", "Eastern", "New_York", "UTC+5"])(
    "rejects the unsupported time zone %j",
    (timeZone) => {
      expect(codes(errorsFor({ ...VALID, timeZone }))).toEqual(["timeZone:unsupported-time-zone"]);
    },
  );

  it("rejects a reversed range with one range-level error", () => {
    const errors = errorsFor({ startDate: "2026-03-02", endDate: "2026-03-01", timeZone: NY });
    expect(codes(errors)).toEqual(["range:start-after-end"]);
    expect(errors[0].message).toBe(
      "Start date 2026-03-02 must be on or before end date 2026-03-01.",
    );
  });

  it("collects errors from several fields together", () => {
    expect(
      codes(errorsFor({ startDate: "2026-02-30", endDate: 5, timeZone: "Nowhere/Zone" })),
    ).toEqual(["startDate:invalid-date", "endDate:not-a-string", "timeZone:unsupported-time-zone"]);
    expect(
      codes(errorsFor({ startDate: "2026-03-02", endDate: "2026-03-01", timeZone: "" })),
    ).toEqual(["timeZone:required", "range:start-after-end"]);
  });

  it("only checks the order of two valid dates", () => {
    expect(codes(errorsFor({ ...VALID, startDate: "2027-13-01" }))).toEqual([
      "startDate:invalid-date",
    ]);
  });

  it("rejects a start date whose local midnight does not exist", () => {
    // America/Santiago moves its clocks forward at midnight on 2026-09-06.
    const errors = errorsFor({
      startDate: "2026-09-06",
      endDate: "2026-09-10",
      timeZone: "America/Santiago",
    });
    expect(codes(errors)).toEqual(["startDate:nonexistent-local-midnight"]);
    expect(errors[0].message).toContain("2026-09-06");
  });

  it("rejects an end date whose following local midnight does not exist", () => {
    const errors = errorsFor({
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      timeZone: "America/Santiago",
    });
    expect(codes(errors)).toEqual(["endDate:nonexistent-local-midnight"]);
    expect(errors[0].message).toContain("2026-09-06");
  });

  it("reports a reversed range before any missing midnight", () => {
    // America/Havana moves its clocks forward at midnight on 2026-03-08.
    expect(
      codes(
        errorsFor({ startDate: "2026-03-08", endDate: "2026-03-07", timeZone: "America/Havana" }),
      ),
    ).toEqual(["range:start-after-end"]);
  });

  it("reports both edges when neither needed local midnight exists", () => {
    // Santiago's DST also starts at midnight on 2027-09-05, the day after the end date.
    expect(
      codes(
        errorsFor({
          startDate: "2026-09-06",
          endDate: "2027-09-04",
          timeZone: "America/Santiago",
        }),
      ),
    ).toEqual(["startDate:nonexistent-local-midnight", "endDate:nonexistent-local-midnight"]);
  });

  it("accepts the days around a missing midnight", () => {
    expect(range("2026-09-07", "2026-09-07", "America/Santiago").startUtc).toBeTruthy();
    expect(range("2026-09-01", "2026-09-04", "America/Santiago").endExclusiveUtc).toBeTruthy();
  });

  it.each([NY, "UTC", "Pacific/Kiritimati"])("rejects an end date of 9999-12-31 in %s", (zone) => {
    expect(
      codes(errorsFor({ startDate: "9999-12-01", endDate: "9999-12-31", timeZone: zone })),
    ).toEqual(["endDate:unsupported-end-date"]);
    expect(range("9999-12-01", "9999-12-30", "UTC").endExclusiveUtc).toBe(
      "9999-12-31T00:00:00.000Z",
    );
  });

  it("freezes failure results", () => {
    const result = validateCustomDateRange({});
    expect(Object.isFrozen(result)).toBe(true);
    expect(!result.ok && Object.isFrozen(result.errors)).toBe(true);
    expect(!result.ok && result.errors.every((e) => Object.isFrozen(e))).toBe(true);
  });

  it("never throws for untrusted input", () => {
    const values: unknown[] = [
      undefined,
      null,
      "",
      " ",
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      {},
      [],
      Symbol("x"),
      10n,
      () => "2026-01-01",
      new Date(Number.NaN),
      "2026-01-01",
      "2026-02-30",
      "9999-12-31",
      "0000-01-01",
      "0001-01-01",
      "America/New_York",
      "America/Santiago",
      "Invalid/Zone",
      "x".repeat(10_000),
    ];
    for (const startDate of values) {
      for (const endDate of values) {
        for (const timeZone of values) {
          expect(() => validateCustomDateRange({ startDate, endDate, timeZone })).not.toThrow();
        }
      }
    }
    for (const input of [undefined, null, "2026-01-01", 42, [], () => {}]) {
      expect(() => validateCustomDateRange(input as unknown as CustomDateRangeInput)).not.toThrow();
    }
  });

  it("gives every error a field, a known code and a readable message", () => {
    const all = [
      ...errorsFor({}),
      ...errorsFor({ startDate: 1, endDate: "x", timeZone: "Bad/Zone" }),
      ...errorsFor({ startDate: "2026-02-30", endDate: "2026-03-01", timeZone: NY }),
      ...errorsFor({ startDate: "2026-03-02", endDate: "2026-03-01", timeZone: NY }),
      ...errorsFor({
        startDate: "2026-09-06",
        endDate: "2026-09-06",
        timeZone: "America/Santiago",
      }),
      ...errorsFor({ startDate: "9999-12-31", endDate: "9999-12-31", timeZone: NY }),
    ];
    for (const e of all) {
      expect(["startDate", "endDate", "timeZone", "range"]).toContain(e.field);
      expect(CUSTOM_DATE_RANGE_ERROR_CODES).toContain(e.code);
      expect(e.message).toMatch(/^[A-Z].+\.$/);
    }
    expect(new Set(all.map((e) => e.code))).toEqual(new Set(CUSTOM_DATE_RANGE_ERROR_CODES));
  });
});

// ---------------------------------------------------------------------------
// Date boundaries
// ---------------------------------------------------------------------------

describe("custom range boundaries (inclusive dates, half-open UTC bounds)", () => {
  it("includes the start and excludes the end-exclusive instant", () => {
    const bounds = range("2026-04-01", "2026-04-30");
    expect(ids(filterByPeriod(edgeRows(bounds), bounds))).toEqual(["start", "end-1ms"]);
  });

  it.each([
    // [label, start, end, expected startUtc, expected endExclusiveUtc, hours]
    [
      "DST spring-forward day",
      "2026-03-08",
      "2026-03-08",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
      23,
    ],
    [
      "DST fall-back day",
      "2026-11-01",
      "2026-11-01",
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
      25,
    ],
    [
      "leap day",
      "2028-02-29",
      "2028-02-29",
      "2028-02-29T05:00:00.000Z",
      "2028-03-01T05:00:00.000Z",
      24,
    ],
    [
      "year-end range",
      "2026-12-31",
      "2027-01-01",
      "2026-12-31T05:00:00.000Z",
      "2027-01-02T05:00:00.000Z",
      48,
    ],
  ])("handles the %s", (_label, startDate, endDate, startUtc, endExclusiveUtc, hours) => {
    const bounds = range(startDate, endDate);
    expect(bounds.startUtc).toBe(startUtc);
    expect(bounds.endExclusiveUtc).toBe(endExclusiveUtc);
    expect((ms(endExclusiveUtc) - ms(startUtc)) / HOUR_MS).toBe(hours);
    expect(ids(filterByPeriod(edgeRows(bounds), bounds))).toEqual(["start", "end-1ms"]);
  });

  it("includes the last Eastern evening of the end date and excludes the next morning", () => {
    const bounds = range("2026-12-31", "2026-12-31");
    const rows: Row[] = [
      { id: "eve", createdAt: "2026-12-31T23:59:59.999-05:00" },
      { id: "new-year", createdAt: "2027-01-01T00:00:00-05:00" },
      { id: "utc-new-year", createdAt: "2027-01-01T00:00:00Z" }, // 7 pm Eastern Dec 31
    ];
    expect(ids(filterByPeriod(rows, bounds))).toEqual(["eve", "utc-new-year"]);
  });
});

// ---------------------------------------------------------------------------
// Cross-period filtering with standard period bounds
// ---------------------------------------------------------------------------

describe("filtering by standard reporting periods", () => {
  it("filters by fiscal year at the July 1 UTC boundary", () => {
    const fy2027 = must(getFiscalYearPeriod("FY2027"), "FY2027");
    const rows: Row[] = [
      { id: "jun-30-utc", createdAt: "2026-06-30T23:59:59.999Z" },
      { id: "jul-1-utc", createdAt: "2026-07-01T00:00:00Z" },
      // 8 pm Eastern on June 30 is already July 1 in UTC, so it is FY2027.
      { id: "jun-30-eastern-evening", createdAt: "2026-06-30T20:00:00-04:00" },
      { id: "jun-30-eastern-afternoon", createdAt: "2026-06-30T19:59:59.999-04:00" },
      { id: "fy-end", createdAt: shift(fy2027.endExclusiveUtc, -1) },
      { id: "next-fy", createdAt: fy2027.endExclusiveUtc },
    ];
    expect(ids(filterByPeriod(rows, fy2027))).toEqual([
      "jul-1-utc",
      "jun-30-eastern-evening",
      "fy-end",
    ]);
    expect(ids(filterByPeriod(edgeRows(fy2027), fy2027))).toEqual(["start", "end-1ms"]);
  });

  it("filters by fiscal quarter, with adjacent quarters sharing one boundary instant", () => {
    const q1 = must(getFiscalQuarterPeriod("FY2027", "Q1"), "FY2027 Q1");
    const q2 = must(getFiscalQuarterPeriod("FY2027", "Q2"), "FY2027 Q2");
    expect(q1.endExclusiveUtc).toBe(q2.startUtc);
    const rows = edgeRows(q1);
    expect(ids(filterByPeriod(rows, q1))).toEqual(["start", "end-1ms"]);
    expect(ids(filterByPeriod(rows, q2))).toEqual(["end"]);
    expect(getFiscalPeriodsForDate("2026-07-01T00:00:00Z")?.quarter.key).toBe(q1.key);
  });

  it("filters by calendar month", () => {
    const august = must(getCalendarMonthPeriod("2026-08"), "2026-08");
    const september = must(getCalendarMonthPeriod("2026-09"), "2026-09");
    const rows = edgeRows(august);
    expect(ids(filterByPeriod(rows, august))).toEqual(["start", "end-1ms"]);
    expect(ids(filterByPeriod(rows, september))).toEqual(["end"]);
  });

  it("filters by academic term", () => {
    const fall = must(getAcademicPeriodByKey("AY2025-2026-FALL"), "Fall 2025");
    const spring = must(getAcademicPeriodByKey("AY2025-2026-SPRING"), "Spring 2026");
    expect(ids(filterByPeriod(edgeRows(fall), fall))).toEqual(["start", "end-1ms"]);
    expect(ids(filterByPeriod(edgeRows(spring), spring))).toEqual(["start", "end-1ms"]);
  });

  it("filters by a Summer session inside its term", () => {
    const summer = must(getAcademicPeriodByKey("AY2025-2026-SUMMER"), "Summer 2026");
    const session = must(getAcademicPeriodByKey("AY2025-2026-SUMMER-1"), "Summer 2026 Session I");
    const rows = edgeRows(session);
    expect(ids(filterByPeriod(rows, session))).toEqual(["start", "end-1ms"]);
    expect(ids(filterByPeriod(rows, summer))).toEqual(["start", "end-1ms", "end"]);
  });

  it("finds rows in the winter break that no academic term contains", () => {
    const fall = must(getAcademicPeriodByKey("AY2025-2026-FALL"), "Fall 2025");
    const spring = must(getAcademicPeriodByKey("AY2025-2026-SPRING"), "Spring 2026");
    // The break runs from the day after Fall ends to the day before Spring starts.
    const winterBreak = range("2025-12-17", "2026-01-11");
    expect(winterBreak.startUtc).toBe(fall.endExclusiveUtc);
    expect(winterBreak.endExclusiveUtc).toBe(spring.startUtc);

    const rows: Row[] = [
      { id: "fall-last-ms", createdAt: shift(fall.endExclusiveUtc, -1) },
      { id: "break-start", createdAt: fall.endExclusiveUtc },
      { id: "christmas", createdAt: "2025-12-25T12:00:00-05:00" },
      { id: "break-last-ms", createdAt: shift(spring.startUtc, -1) },
      { id: "spring-start", createdAt: spring.startUtc },
    ];
    const inBreak = filterByPeriod(rows, winterBreak);
    expect(ids(inBreak)).toEqual(["break-start", "christmas", "break-last-ms"]);
    for (const row of inBreak) {
      expect(getAcademicTermForDate(row.createdAt as string)).toBeNull();
      expect(isWithinPeriod(fall, row.createdAt as string)).toBe(false);
      expect(isWithinPeriod(spring, row.createdAt as string)).toBe(false);
    }
    expect(ids(filterByPeriod(rows, fall))).toEqual(["fall-last-ms"]);
    expect(ids(filterByPeriod(rows, spring))).toEqual(["spring-start"]);
  });

  it("accepts academic calendar coverage as bounds", () => {
    const coverage = getAcademicCalendarCoverage();
    expect(ids(filterByPeriod(edgeRows(coverage), coverage))).toEqual(["start", "end-1ms"]);
  });
});

describe("custom ranges spanning several reporting periods", () => {
  const span = range("2025-12-01", "2026-01-31");
  const rows: Row[] = [
    { id: "nov-30-evening", createdAt: "2025-11-30T23:59:59.999-05:00" },
    { id: "fall-december", createdAt: "2025-12-10T09:00:00-05:00" },
    { id: "break", createdAt: "2025-12-28T14:00:00-05:00" },
    { id: "dec-31-evening", createdAt: "2025-12-31T21:00:00-05:00" }, // already Jan 1 UTC
    { id: "spring-january", createdAt: "2026-01-20T10:00:00-05:00" },
    { id: "jan-31-evening", createdAt: "2026-01-31T23:00:00-05:00" }, // already Feb 1 UTC
    { id: "feb-1", createdAt: "2026-02-01T00:00:00-05:00" },
  ];

  it("returns every row inside the range across period boundaries", () => {
    expect(ids(filterByPeriod(rows, span))).toEqual([
      "fall-december",
      "break",
      "dec-31-evening",
      "spring-january",
      "jan-31-evening",
    ]);
  });

  it("spans fiscal quarters, calendar months and academic terms", () => {
    const matched = filterByPeriod(rows, span).map((row) => row.createdAt as string);
    const fiscalQuarters = new Set(matched.map((at) => getFiscalPeriodsForDate(at)?.quarter.key));
    const months = new Set(matched.map((at) => getCalendarMonthForDate(at)?.key));
    const terms = new Set(matched.map((at) => getAcademicTermForDate(at)?.key ?? "break"));
    // 9 pm Eastern on Dec 31 is already Jan 1 UTC (Q3); 11 pm Eastern on Jan 31
    // is already Feb 1 UTC, so the months reach February.
    expect([...fiscalQuarters].sort()).toEqual(["FY2026-Q2", "FY2026-Q3"]);
    expect([...months].sort()).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect([...terms].sort()).toEqual(["AY2025-2026-FALL", "AY2025-2026-SPRING", "break"]);
  });

  it("matches the union of the standard periods it overlaps, clipped to the range", () => {
    const periods = [
      must(getFiscalQuarterPeriod("FY2026", "Q2"), "FY2026 Q2"),
      must(getFiscalQuarterPeriod("FY2026", "Q3"), "FY2026 Q3"),
    ];
    const union = rows.filter((row) =>
      periods.some((period) => filterByPeriod([row], period).length === 1),
    );
    const clipped = filterByPeriod(union, span);
    expect(clipped).toEqual(filterByPeriod(rows, span));
  });
});

describe("custom ranges equivalent to standard periods", () => {
  const sample: Row[] = [
    "2025-08-17T23:59:59.999-04:00",
    "2025-08-18T00:00:00-04:00",
    "2025-10-15T12:00:00Z",
    "2025-12-16T23:59:59.999-05:00",
    "2025-12-17T00:00:00-05:00",
    "2026-06-30T23:59:59.999Z",
    "2026-07-01T00:00:00Z",
    "2026-08-01T00:00:00Z",
    "2026-08-31T21:00:00-04:00",
    "2026-09-30T23:59:59.999Z",
    "2026-10-01T00:00:00Z",
  ].map((createdAt, index) => ({ id: `row-${index}`, createdAt }));

  it("matches an academic term when built from its published local dates in the institutional zone", () => {
    const fall = must(getAcademicPeriodByKey("AY2025-2026-FALL"), "Fall 2025");
    const custom = range(fall.localStartDate, fall.localEndDate, CUSTOM_DATE_RANGE_TIME_ZONE);
    expect({ startUtc: custom.startUtc, endExclusiveUtc: custom.endExclusiveUtc }).toEqual({
      startUtc: fall.startUtc,
      endExclusiveUtc: fall.endExclusiveUtc,
    });
    expect(filterByPeriod(sample, custom)).toEqual(filterByPeriod(sample, fall));
    expect(filterByPeriod(sample, custom).length).toBeGreaterThan(0);
  });

  it("matches a calendar month and a fiscal quarter when built in UTC", () => {
    const august = must(getCalendarMonthPeriod("2026-08"), "2026-08");
    const q1 = must(getFiscalQuarterPeriod("FY2027", "Q1"), "FY2027 Q1");
    const toLocal = (iso: string) => iso.slice(0, 10);
    const customMonth = range(
      toLocal(august.startUtc),
      toLocal(shift(august.endExclusiveUtc, -1)),
      "UTC",
    );
    const customQuarter = range(
      toLocal(q1.startUtc),
      toLocal(shift(q1.endExclusiveUtc, -1)),
      "UTC",
    );
    expect(customMonth.startUtc).toBe(august.startUtc);
    expect(customMonth.endExclusiveUtc).toBe(august.endExclusiveUtc);
    expect(customQuarter.startUtc).toBe(q1.startUtc);
    expect(customQuarter.endExclusiveUtc).toBe(q1.endExclusiveUtc);
    expect(filterByPeriod(sample, customMonth)).toEqual(filterByPeriod(sample, august));
    expect(filterByPeriod(sample, customQuarter)).toEqual(filterByPeriod(sample, q1));
  });
});

// ---------------------------------------------------------------------------
// Mixed time zones
// ---------------------------------------------------------------------------

describe("UTC calendar months versus Eastern custom ranges", () => {
  const ninePmEasternAug31 = "2026-08-31T21:00:00-04:00"; // 2026-09-01T01:00Z

  it("puts 9 pm Eastern on August 31 in September (UTC) but inside an Eastern range ending August 31", () => {
    const august = must(getCalendarMonthPeriod("2026-08"), "2026-08");
    const september = must(getCalendarMonthPeriod("2026-09"), "2026-09");
    const easternAugust = range("2026-08-01", "2026-08-31", CUSTOM_DATE_RANGE_TIME_ZONE);
    const rows: Row[] = [{ id: "aug-31-9pm-eastern", createdAt: ninePmEasternAug31 }];

    expect(getCalendarMonthForDate(ninePmEasternAug31)?.key).toBe("2026-09");
    expect(filterByPeriod(rows, september)).toHaveLength(1);
    expect(filterByPeriod(rows, august)).toHaveLength(0);
    expect(filterByPeriod(rows, easternAugust)).toHaveLength(1);
  });

  it("offsets the Eastern range from the UTC month by the zone's offset", () => {
    const august = must(getCalendarMonthPeriod("2026-08"), "2026-08");
    const easternAugust = range("2026-08-01", "2026-08-31");
    expect(ms(easternAugust.startUtc) - ms(august.startUtc)).toBe(4 * HOUR_MS);
    expect(ms(easternAugust.endExclusiveUtc) - ms(august.endExclusiveUtc)).toBe(4 * HOUR_MS);
  });
});

// ---------------------------------------------------------------------------
// Invalid rows
// ---------------------------------------------------------------------------

describe("rows with missing or invalid timestamps", () => {
  const august = range("2026-08-01", "2026-08-31");
  const rows: Row[] = [
    { id: "valid", createdAt: "2026-08-15T12:00:00.123456+00:00" },
    { id: "missing" },
    { id: "undefined", createdAt: undefined },
    { id: "null", createdAt: null },
    { id: "empty", createdAt: "" },
    { id: "garbage", createdAt: "not a date" },
    { id: "date-only", createdAt: "2026-08-15" },
    { id: "no-offset", createdAt: "2026-08-15T12:00:00" },
    { id: "postgres-text", createdAt: "2026-08-15 12:00:00+00" },
    { id: "impossible", createdAt: "2026-08-32T12:00:00Z" },
    { id: "invalid-date-object", createdAt: new Date(Number.NaN) },
    { id: "nan", createdAt: Number.NaN },
    { id: "object", createdAt: { iso: "2026-08-15T12:00:00Z" } },
    { id: "submitted-only", submittedAt: "2026-08-15" },
    { id: "invalid-created-valid-submitted", createdAt: "garbage", submittedAt: "2026-08-15" },
    // Even a full, valid in-range submittedAt timestamp must not be used.
    { id: "full-submitted-only", submittedAt: "2026-08-15T12:00:00Z" },
    {
      id: "missing-created-full-submitted",
      createdAt: undefined,
      submittedAt: "2026-08-15T12:00:00Z",
    },
    { id: "empty-created-full-submitted", createdAt: "", submittedAt: "2026-08-15T12:00:00Z" },
    { id: "date-object", createdAt: new Date("2026-08-20T12:00:00Z") },
    { id: "epoch-ms", createdAt: Date.parse("2026-08-21T12:00:00Z") },
  ];

  it("excludes them without throwing and never falls back to submittedAt", () => {
    expect(() => filterByPeriod(rows, august)).not.toThrow();
    expect(ids(filterByPeriod(rows, august))).toEqual(["valid", "date-object", "epoch-ms"]);
  });

  it("excludes them from every kind of period, so they are never assigned to one", () => {
    const periods: PeriodBounds[] = [
      must(getFiscalYearPeriod("FY2027"), "FY2027"),
      must(getCalendarMonthPeriod("2026-08"), "2026-08"),
      getAcademicCalendarCoverage(),
      range("0001-01-01", "9999-12-30", "UTC"),
    ];
    const invalid = rows.filter((row) => !["valid", "date-object", "epoch-ms"].includes(row.id));
    for (const period of periods) {
      expect(filterByPeriod(invalid, period)).toEqual([]);
    }
  });

  it("uses a custom accessor's value and treats a missing value as invalid", () => {
    const events = [
      { id: "a", updated: "2026-08-02T00:00:00Z", createdAt: "2020-01-01T00:00:00Z" },
      { id: "b", updated: undefined, createdAt: "2026-08-02T00:00:00Z" },
      { id: "c", updated: "2026-09-02T00:00:00Z", createdAt: "2026-08-02T00:00:00Z" },
    ];
    expect(ids(filterByPeriod(events, august, (event) => event.updated))).toEqual(["a"]);
  });

  it("does not throw for null or undefined rows with the default accessor", () => {
    const sparse = [null, undefined, { id: "x", createdAt: "2026-08-02T00:00:00Z" }] as unknown as {
      createdAt?: string;
    }[];
    expect(filterByPeriod(sparse, august)).toEqual([sparse[2]]);
  });
});

// ---------------------------------------------------------------------------
// Immutability and order
// ---------------------------------------------------------------------------

describe("immutability and order", () => {
  const bounds = range("2026-01-01", "2026-12-31");
  const make = (): Row[] => [
    { id: "c", createdAt: "2026-06-01T00:00:00Z" },
    { id: "out", createdAt: "2025-06-01T00:00:00Z" },
    { id: "a", createdAt: "2026-02-01T00:00:00Z" },
    { id: "b", createdAt: "2026-11-01T00:00:00Z" },
  ];

  it("preserves input order rather than sorting by time", () => {
    expect(ids(filterByPeriod(make(), bounds))).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array or its rows", () => {
    const input = make();
    const snapshot = structuredClone(input);
    Object.freeze(input);
    input.forEach((row) => Object.freeze(row));
    filterByPeriod(input, bounds);
    expect(input).toEqual(snapshot);
  });

  it("returns a new array of the original row objects", () => {
    const input = make().filter((row) => row.id !== "out");
    const result = filterByPeriod(input, bounds);
    expect(result).not.toBe(input);
    expect(result).toEqual(input);
    result.forEach((row, index) => expect(row).toBe(input[index]));
  });

  it("returns a new empty array when nothing matches", () => {
    const empty: Row[] = [];
    const none = filterByPeriod(empty, bounds);
    expect(none).toEqual([]);
    expect(none).not.toBe(empty);
    expect(filterByPeriod(make(), range("2030-01-01", "2030-01-01"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Host time zone independence
// ---------------------------------------------------------------------------

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
    const filter = await import("./date-range-filter");
    const rp = await import("./reporting-periods");
    const rows = [
      "2025-12-16T23:59:59.999-05:00",
      "2025-12-17T00:00:00-05:00",
      "2026-03-08T06:59:59.999Z",
      "2026-06-30T20:00:00-04:00",
      "2026-08-31T21:00:00-04:00",
      "2026-11-01T05:30:00Z",
      "2026-12-31T23:30:00-05:00",
      "2028-02-29T04:59:59.999Z",
      "2026-08-15",
      "2026-08-15T12:00:00",
    ].map((createdAt, index) => ({ id: `row-${index}`, createdAt }));

    const ranges = [
      ["2025-12-17", "2026-01-11"],
      ["2026-03-08", "2026-03-08"],
      ["2026-08-01", "2026-08-31"],
      ["2026-11-01", "2026-11-01"],
      ["2026-12-31", "2027-01-01"],
      ["2028-02-29", "2028-02-29"],
    ].map(([startDate, endDate]) =>
      filter.validateCustomDateRange({
        startDate,
        endDate,
        timeZone: filter.CUSTOM_DATE_RANGE_TIME_ZONE,
      }),
    );
    const periods: PeriodBounds[] = [
      must(rp.getFiscalYearPeriod("FY2027"), "FY2027"),
      must(rp.getFiscalQuarterPeriod("FY2026", "Q2"), "FY2026 Q2"),
      must(rp.getCalendarMonthPeriod("2026-08"), "2026-08"),
      must(rp.getCalendarMonthPeriod("2026-09"), "2026-09"),
      must(rp.getAcademicPeriodByKey("AY2025-2026-FALL"), "Fall 2025"),
      must(rp.getAcademicPeriodByKey("AY2025-2026-SPRING"), "Spring 2026"),
    ];
    return {
      ranges,
      customMatches: ranges.map((result) =>
        result.ok ? ids(filter.filterByPeriod(rows, result.range)) : null,
      ),
      periodMatches: periods.map((period) => ids(filter.filterByPeriod(rows, period))),
      errors: filter.validateCustomDateRange({
        startDate: "2026-09-06",
        endDate: "2026-09-05",
        timeZone: "America/Santiago",
      }),
    };
  }

  it("gives identical validation and filtering results whatever the host time zone is", async () => {
    process.env.TZ = "UTC";
    const baseline = await runBattery();
    expect(baseline.customMatches.every((match) => match !== null)).toBe(true);
    for (const [hostZone, januaryOffset] of HOST_ZONES) {
      process.env.TZ = hostZone;
      // Guard: fail loudly if the runtime did not actually switch zones, so this
      // test can never pass without testing anything.
      expect(new Date("2026-01-15T12:00:00Z").getTimezoneOffset()).toBe(januaryOffset);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(canonical(hostZone));
      expect(await runBattery(), `host zone ${hostZone}`).toEqual(baseline);
    }
  });
});
