import { describe, expect, it } from "vitest";
import { deepFreeze } from "./deep-freeze";
import { HOWARD_ACADEMIC_CALENDAR } from "./howard-academic-calendar";
// Importing the shipped module runs its eager validation; a calendar edit that
// breaks validation makes this whole file fail to load in CI.
import {
  REPORTING_PERIOD_CONFIG,
  REPORTING_PERIOD_CONFIG_VERSION,
  defineReportingPeriodConfig,
  validateReportingPeriodConfig,
  type ReportingPeriodConfig,
} from "./reporting-period-config";
import {
  buildAcademicPeriods,
  getAcademicCalendarCoverage,
  type AcademicCalendarYear,
} from "./reporting-periods";

/** A valid academic year shaped like the official 2026-2027 calendar, for any start year. */
function makeYear(startYear: number): AcademicCalendarYear {
  const s = String(startYear);
  const e = String(startYear + 1);
  return {
    academicYear: `AY${s}-${e}`,
    sources: [
      { url: "https://example.edu/calendar", publishedBy: "Fixture", retrievedOn: "2026-11-18" },
    ],
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

/** A fresh, mutable, valid configuration. */
function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "2026-11-18.1",
    academicCalendar: [makeYear(2025), makeYear(2026)],
    ...overrides,
  };
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

const VERSION_ERROR =
  "version: must match YYYY-MM-DD.N with a real date and N of 1 or more without leading zeros";

/** Every object and array in a value, so tests can check that none was frozen. */
function collectObjects(value: unknown, found = new Set<object>()): Set<object> {
  if (value !== null && typeof value === "object" && !found.has(value)) {
    found.add(value);
    Reflect.ownKeys(value).forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) collectObjects(descriptor.value, found);
    });
  }
  return found;
}

function expectNothingFrozen(value: unknown) {
  for (const node of collectObjects(value)) expect(Object.isFrozen(node)).toBe(false);
}

function expectConfigError(candidate: unknown, expected: string) {
  const result = validateReportingPeriodConfig(candidate);
  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.errors).toContain(expected);
}

describe("shipped reporting period configuration", () => {
  it("passes validation and carries a well-formed version", () => {
    expect(validateReportingPeriodConfig(REPORTING_PERIOD_CONFIG)).toEqual({
      ok: true,
      data: REPORTING_PERIOD_CONFIG,
    });
    expect(REPORTING_PERIOD_CONFIG.version).toBe(REPORTING_PERIOD_CONFIG_VERSION);
    expect(REPORTING_PERIOD_CONFIG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("uses the official calendar object itself, sharing its period cache", () => {
    expect(REPORTING_PERIOD_CONFIG.academicCalendar).toBe(HOWARD_ACADEMIC_CALENDAR);
    expect(buildAcademicPeriods(REPORTING_PERIOD_CONFIG.academicCalendar)).toBe(
      buildAcademicPeriods(),
    );
    expect(getAcademicCalendarCoverage(REPORTING_PERIOD_CONFIG.academicCalendar)).toBe(
      getAcademicCalendarCoverage(),
    );
  });

  it("has only the version and academic calendar (fiscal rules are not configured here)", () => {
    expect(Object.keys(REPORTING_PERIOD_CONFIG).sort()).toEqual(["academicCalendar", "version"]);
  });

  it("is deeply frozen and cannot be changed at runtime", () => {
    expect(isDeeplyFrozen(REPORTING_PERIOD_CONFIG)).toBe(true);
    const mutable = REPORTING_PERIOD_CONFIG as unknown as {
      version: string;
      academicCalendar: { fall: { startDate: string } }[];
    };
    expect(() => {
      mutable.version = "2099-01-01.1";
    }).toThrow(TypeError);
    expect(() => {
      mutable.academicCalendar[0].fall.startDate = "2025-01-01";
    }).toThrow(TypeError);
    expect(() => mutable.academicCalendar.push(mutable.academicCalendar[0])).toThrow(TypeError);
    expect(REPORTING_PERIOD_CONFIG.version).toBe(REPORTING_PERIOD_CONFIG_VERSION);
    expect(REPORTING_PERIOD_CONFIG.academicCalendar[0].fall.startDate).toBe("2025-08-18");
    expect(REPORTING_PERIOD_CONFIG.academicCalendar).toHaveLength(2);
  });
});

describe("validateReportingPeriodConfig", () => {
  it("accepts a valid configuration and returns the same object", () => {
    const candidate = makeConfig();
    const result = validateReportingPeriodConfig(candidate);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(candidate);
    expect(Object.isFrozen(candidate)).toBe(false); // validation alone never freezes
  });

  it("rejects a missing or malformed version", () => {
    const { version: _omitted, ...withoutVersion } = makeConfig();
    expectConfigError(withoutVersion, "version: Required");
    expectConfigError(makeConfig({ version: 1 }), "version: Expected string, received number");
    for (const version of ["v1", "2026-11-18", "2026-11-18.", "26-11-18.1", " 2026-11-18.1"]) {
      expectConfigError(makeConfig({ version }), VERSION_ERROR);
    }
  });

  it("rejects versions whose date is not a real calendar date", () => {
    for (const version of ["2026-99-99.007", "2026-13-01.1", "2026-02-29.1", "2026-11-31.1"]) {
      expectConfigError(makeConfig({ version }), VERSION_ERROR);
    }
  });

  it("rejects a sequence number that is zero, has leading zeros, or is not a whole number", () => {
    for (const version of ["2026-11-18.0", "2026-11-18.01", "2026-11-18.007", "2026-11-18.1a"]) {
      expectConfigError(makeConfig({ version }), VERSION_ERROR);
    }
    expectConfigError(makeConfig({ version: "2026-11-18.-1" }), VERSION_ERROR);
    expectConfigError(makeConfig({ version: "2026-11-18.1.2" }), VERSION_ERROR);
  });

  it("accepts real dates, including a leap day, with any positive sequence number", () => {
    for (const version of ["2026-11-18.1", "2028-02-29.1", "2026-12-31.2", "2026-01-01.10"]) {
      expect(validateReportingPeriodConfig(makeConfig({ version })).ok, version).toBe(true);
    }
  });

  it("rejects unknown keys, including a fiscal section", () => {
    const result = validateReportingPeriodConfig(makeConfig({ fiscal: { yearStartMonth: 7 } }));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join("\n")).toContain("Unrecognized key(s)");
    expect(result.ok ? [] : result.errors.join("\n")).toContain("'fiscal'");
  });

  it("rejects non-object candidates", () => {
    expectConfigError(null, "config: Expected object, received null");
    expectConfigError([], "config: Expected object, received array");
  });

  it("reports academic calendar errors with their full path", () => {
    const calendar = [makeYear(2025), makeYear(2026)];
    const broken = { ...calendar[1], fall: { startDate: "2026-08-17", endDate: "2026-02-30" } };
    expectConfigError(
      makeConfig({ academicCalendar: [calendar[0], broken] }),
      "academicCalendar.1.fall.endDate: must be a real calendar date in YYYY-MM-DD format",
    );
    expectConfigError(
      makeConfig({ academicCalendar: [] }),
      "academicCalendar: at least one academic year is required",
    );
    expectConfigError(
      makeConfig({ academicCalendar: [makeYear(2025), makeYear(2025)] }),
      "academicCalendar.1.academicYear: duplicate academic year AY2025-2026",
    );
  });

  it("rejects a missing academic year between covered years", () => {
    expectConfigError(
      makeConfig({ academicCalendar: [makeYear(2025), makeYear(2027)] }),
      "academicCalendar: Academic calendar years must be consecutive: AY2026-2027 is missing " +
        "between AY2025-2026 and AY2027-2028",
    );
  });

  it("accepts academic years in any array order", () => {
    expect(
      validateReportingPeriodConfig(
        makeConfig({ academicCalendar: [makeYear(2026), makeYear(2025)] }),
      ).ok,
    ).toBe(true);
  });
});

describe("defineReportingPeriodConfig", () => {
  it("deep-freezes a valid configuration in place and returns the same object", () => {
    const candidate = makeConfig();
    const config: ReportingPeriodConfig = defineReportingPeriodConfig(candidate);
    expect(config).toBe(candidate);
    expect(isDeeplyFrozen(candidate)).toBe(true);
  });

  it("throws every validation message and leaves invalid input unfrozen", () => {
    const calendar = [makeYear(2025), makeYear(2027)];
    const candidate = makeConfig({ version: "v1", academicCalendar: calendar });
    expect(() => defineReportingPeriodConfig(candidate)).toThrow(
      "Invalid reporting period configuration: version: must match YYYY-MM-DD.N",
    );
    expect(Object.isFrozen(candidate)).toBe(false);
    expect(Object.isFrozen(calendar)).toBe(false);
    expect(Object.isFrozen(calendar[0])).toBe(false);

    const gap = makeConfig({ academicCalendar: calendar });
    expect(() => defineReportingPeriodConfig(gap)).toThrow(
      "Invalid reporting period configuration: academicCalendar: Academic calendar years must " +
        "be consecutive",
    );
    expect(Object.isFrozen(gap)).toBe(false);
    expect(Object.isFrozen(calendar[1])).toBe(false);
  });

  it("joins multiple messages", () => {
    expect(() => defineReportingPeriodConfig({ version: "v1", academicCalendar: [] })).toThrow(
      `Invalid reporting period configuration: ${VERSION_ERROR}; ` +
        "academicCalendar: at least one academic year is required",
    );
  });

  it("throws and freezes nothing for an array with an extra property or a circular reference", () => {
    const extra = makeConfig();
    Object.assign(extra.academicCalendar as object, { note: { anything: 1 } });
    expect(() => defineReportingPeriodConfig(extra)).toThrow(
      "Invalid reporting period configuration: academicCalendar.note: unexpected array property",
    );
    expectNothingFrozen(extra);

    const circular = makeConfig();
    const years = circular.academicCalendar as Record<string, unknown>[];
    (years[1].fall as Record<string, unknown>).back = circular;
    expect(() => defineReportingPeriodConfig(circular)).toThrow(
      "Invalid reporting period configuration: academicCalendar.1.fall.back: circular reference",
    );
    expectNothingFrozen(circular);
  });
});

describe("structure checks Zod does not perform", () => {
  it("rejects an extra property on the calendar array or a nested array", () => {
    const calendar = [makeYear(2025), makeYear(2026)];
    expect(validateReportingPeriodConfig(makeConfig({ academicCalendar: calendar })).ok).toBe(true);
    Object.assign(calendar, { note: "not validated by Zod" });
    expectConfigError(
      makeConfig({ academicCalendar: calendar }),
      "academicCalendar.note: unexpected array property",
    );

    const sources = makeYear(2026);
    Object.assign(sources.sources, { extra: true });
    expectConfigError(
      makeConfig({ academicCalendar: [makeYear(2025), sources] }),
      "academicCalendar.1.sources.extra: unexpected array property",
    );
  });

  it("rejects circular references anywhere in the configuration", () => {
    const selfArray = makeConfig();
    (selfArray.academicCalendar as unknown[]).push(selfArray.academicCalendar);
    expectConfigError(selfArray, "academicCalendar.2: circular reference");

    const toRoot = makeConfig();
    const year = (toRoot.academicCalendar as Record<string, unknown>[])[0];
    (year.summer as Record<string, unknown>).loop = year;
    expectConfigError(toRoot, "academicCalendar.0.summer.loop: circular reference");
  });

  it("rejects symbol-keyed, non-enumerable, and accessor properties", () => {
    const symbol = makeConfig();
    (symbol as unknown as Record<symbol, unknown>)[Symbol("hidden")] = 1;
    expectConfigError(symbol, "config: symbol-keyed properties are not allowed");

    const hidden = makeConfig();
    Object.defineProperty(hidden, "secret", { value: 1, enumerable: false });
    expectConfigError(hidden, "secret: non-enumerable properties are not allowed");

    const accessor = makeConfig();
    Object.defineProperty(accessor, "version", { get: () => "2026-11-18.1", enumerable: true });
    expectConfigError(accessor, "version: accessor properties are not allowed");
  });

  it("allows the same object to be shared by two places, which is not circular", () => {
    const sharedSources = makeYear(2025).sources;
    const calendar = [
      { ...makeYear(2025), sources: sharedSources },
      { ...makeYear(2026), sources: sharedSources },
    ];
    const config = makeConfig({ academicCalendar: calendar });
    expect(validateReportingPeriodConfig(config).ok).toBe(true);
    expect(defineReportingPeriodConfig(config)).toBe(config);
    expect(isDeeplyFrozen(config)).toBe(true);
  });

  it("does not freeze or change the candidate when validation fails", () => {
    const candidate = makeConfig({ version: "2026-99-99.007" });
    const before = structuredClone(candidate);
    expect(validateReportingPeriodConfig(candidate).ok).toBe(false);
    expect(candidate).toEqual(before);
    expectNothingFrozen(candidate);
  });
});

describe("deepFreeze (shared utility)", () => {
  it("freezes nested objects and arrays in place and returns the same value", () => {
    const value = { a: [{ b: 1 }], c: { d: "x" } };
    expect(deepFreeze(value)).toBe(value);
    expect(isDeeplyFrozen(value)).toBe(true);
  });

  it("returns primitives and null unchanged", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze("text")).toBe("text");
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it("terminates on circular references and freezes every object in the cycle", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    const list: unknown[] = [a];
    list.push(list);
    expect(deepFreeze(list)).toBe(list);
    expect([list, a, b].every((node) => Object.isFrozen(node))).toBe(true);
  });

  it("freezes an object shared by two parents", () => {
    const shared = { value: 1 };
    const value = { first: shared, second: shared };
    deepFreeze(value);
    expect(Object.isFrozen(shared)).toBe(true);
  });
});
