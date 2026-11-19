import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Constants } from "@/integrations/supabase/types";
import { gateMetricLoad } from "./efficiency-classification";
import {
  checkDatasetIntegrity,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type TableReadResult,
} from "./efficiency-data";
import { EFFICIENCY_METRICS, EFFICIENCY_METRICS_VERSION } from "./efficiency-metrics";
import {
  calculateRequestVolume,
  type RequestVolumeCalculated,
  type RequestVolumeResult,
} from "./efficiency-request-volume";
import { validateCustomDateRange } from "./date-range-filter";
import { getCalendarMonthPeriod } from "./reporting-periods";
import type { PeriodBounds } from "./time-zones";

// ---------------------------------------------------------------------------
// Fixtures: real F19.3 row and read shapes, real F18 periods
// ---------------------------------------------------------------------------

const CATALOG = EFFICIENCY_METRICS.request_volume;

function monthPeriod(key: string): PeriodBounds {
  const period = getCalendarMonthPeriod(key);
  if (!period) throw new Error(`no calendar month ${key}`);
  return period;
}

/** November 2026, UTC: [2026-11-01T00:00Z, 2026-12-01T00:00Z). */
const NOVEMBER = monthPeriod("2026-11");
const OCTOBER = monthPeriod("2026-10");
const DECEMBER = monthPeriod("2026-12");

function request(
  id: string,
  createdAt: string,
  status: EfficiencyRequestRow["status"] = "submitted",
): EfficiencyRequestRow {
  return { id, status, created_at: createdAt };
}

let stageCounter = 0;
function stage(requestId: string, overrides: Partial<EfficiencyStageRow> = {}): EfficiencyStageRow {
  stageCounter += 1;
  return {
    id: `stage-${String(stageCounter).padStart(4, "0")}`,
    request_id: requestId,
    workflow_revision: 1,
    stage_order: 1,
    queue_id: "department_budget",
    status: "completed",
    started_at: "2026-11-02T00:00:00+00:00",
    completed_at: "2026-11-03T00:00:00+00:00",
    ...overrides,
  };
}

const WINDOW = {
  readStartedAt: "2026-11-19T08:00:00.000Z",
  readCompletedAt: "2026-11-19T08:00:01.000Z",
};
const complete = <Row>(rows: Row[]): TableReadResult<Row> => ({
  status: "complete",
  rows,
  expectedCount: rows.length,
  pagesRead: 2,
  window: WINDOW,
});
const failed = <Row>(kind: "access" | "unavailable"): TableReadResult<Row> => ({
  status: "failed",
  error: { code: kind === "access" ? "42501" : "503", message: "read failed" },
  issue: { kind, message: `${kind} message` },
  pagesRead: 1,
});
const incomplete = <Row>(): TableReadResult<Row> => ({
  status: "incomplete",
  reason: "count_mismatch",
  counts: { expectedBefore: 3, expectedAfter: 4, collected: 3 },
  pagesRead: 2,
});
const fieldMissing = <Row>(field: string): TableReadResult<Row> => ({
  status: "field_missing",
  missing: { rowIndex: 0, field },
  pagesRead: 1,
});
const cancelled = <Row>(): TableReadResult<Row> => ({ status: "cancelled", pagesRead: 0 });

const load = (
  requests: TableReadResult<EfficiencyRequestRow>,
  stages: TableReadResult<EfficiencyStageRow> = complete([]),
): DatasetIntegrityResult => checkDatasetIntegrity({ requests, stages });

const loadOf = (requests: EfficiencyRequestRow[], stages: EfficiencyStageRow[] = []) =>
  load(complete(requests), complete(stages));

function calculated(result: RequestVolumeResult): RequestVolumeCalculated {
  if (result.status !== "calculated") throw new Error(`expected calculated, got ${result.status}`);
  return result;
}

const volume = (
  requests: EfficiencyRequestRow[],
  period: PeriodBounds = NOVEMBER,
  prototypeRequests?: EfficiencyRequestRow[],
) => calculated(calculateRequestVolume({ load: loadOf(requests), period, prototypeRequests }));

const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);

/** A deep snapshot for checking that inputs are unchanged. */
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("Request Volume catalog definition", () => {
  it("is the definition this calculation follows", () => {
    expect(CATALOG.statistic).toBe("count");
    expect(CATALOG.emptyResult).toBe("zero");
    expect(CATALOG.requiredReads).toEqual(["financial_requests"]);
    expect(CATALOG.period).toMatchObject({
      mode: "period",
      anchor: { table: "financial_requests", field: "created_at" },
    });
    expect(CATALOG.population.subject).toBe("request");
    expect(CATALOG.population.conditions.map((c) => c.exclusion)).toEqual([
      "prototype_request",
      "invalid_created_at",
    ]);
    expect(CATALOG.flags).toEqual([]);
    expect(CATALOG.separateReports).toEqual([]);
  });

  it("reports exclusion counts in catalog order with the catalog version", () => {
    const result = volume([request("r1", "2026-11-05T10:00:00Z")]);
    expect(Object.keys(result.population.exclusionCounts)).toEqual(
      CATALOG.population.conditions.map((c) => c.exclusion),
    );
    expect(result.catalogVersion).toBe(EFFICIENCY_METRICS_VERSION);
    expect(result.metricId).toBe("request_volume");
  });
});

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

describe("Request Volume period filtering", () => {
  it("counts requests created inside the period (1)", () => {
    const result = volume([
      request("r1", "2026-11-05T10:00:00Z"),
      request("r2", "2026-11-18T12:34:56.123456+00:00"),
    ]);
    expect(result.value).toBe(2);
    expect(ids(result.counted)).toEqual(["r1", "r2"]);
  });

  it("includes a request created exactly at the period start (2)", () => {
    const result = volume([request("start", NOVEMBER.startUtc)]);
    expect(result.value).toBe(1);
  });

  it("excludes a request created exactly at the period end, which belongs to the next period (3)", () => {
    const rows = [
      request("last-ms", "2026-11-30T23:59:59.999Z"),
      request("end", NOVEMBER.endExclusiveUtc),
    ];
    expect(ids(volume(rows, NOVEMBER).counted)).toEqual(["last-ms"]);
    expect(ids(volume(rows, DECEMBER).counted)).toEqual(["end"]);
  });

  it("uses each timestamp's own offset", () => {
    // 2026-11-30T20:00-05:00 is 2026-12-01T01:00Z: December in UTC.
    const result = volume([request("offset", "2026-11-30T20:00:00-05:00")]);
    expect(result.value).toBe(0);
    expect(volume([request("offset", "2026-11-30T20:00:00-05:00")], DECEMBER).value).toBe(1);
  });

  it("does not count a request created before the period, even if decided during it (4)", () => {
    const early = request("early", "2026-10-31T23:59:59.999Z", "approved");
    const decidedInNovember = stage("early", {
      started_at: "2026-10-31T23:59:59.999Z",
      completed_at: "2026-11-10T09:00:00Z",
    });
    const result = calculated(
      calculateRequestVolume({ load: loadOf([early], [decidedInNovember]), period: NOVEMBER }),
    );
    expect(result.value).toBe(0);
    expect(ids(result.population.included)).toEqual(["early"]);
    expect(volume([early], OCTOBER).value).toBe(1);
  });

  it("counts requests of every status (5)", () => {
    const statuses = Constants.public.Enums.request_status;
    expect(statuses).toEqual(["submitted", "under_review", "approved", "rejected", "completed"]);
    const rows = statuses.map((status, i) =>
      request(`r-${status}`, `2026-11-0${i + 1}T12:00:00Z`, status),
    );
    const result = volume(rows);
    expect(result.value).toBe(statuses.length);
    expect(result.counted.map((r) => r.status)).toEqual([...statuses]);
    expect(result.population.excluded).toEqual([]);
  });

  it("works with any F18 bounds, such as a custom America/New_York range", () => {
    const validated = validateCustomDateRange({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      timeZone: "America/New_York",
    });
    if (!validated.ok) throw new Error("expected a valid range");
    const { range } = validated;
    const before = new Date(Date.parse(range.startUtc) - 1).toISOString();
    const lastMs = new Date(Date.parse(range.endExclusiveUtc) - 1).toISOString();
    const result = volume(
      [
        request("before", before),
        request("start", range.startUtc),
        request("last", lastMs),
        request("end", range.endExclusiveUtc),
      ],
      range,
    );
    expect(ids(result.counted)).toEqual(["start", "last"]);
  });

  it("returns the period it was calculated for", () => {
    const result = volume([]);
    expect(result.period).toEqual({
      startUtc: NOVEMBER.startUtc,
      endExclusiveUtc: NOVEMBER.endExclusiveUtc,
    });
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("Request Volume exclusions", () => {
  it("excludes prototype requests, even when created inside the period (6)", () => {
    const prototype = request("proto", "2026-11-05T10:00:00Z");
    const result = volume([request("real", "2026-11-05T10:00:00Z")], NOVEMBER, [prototype]);
    expect(result.value).toBe(1);
    expect(ids(result.counted)).toEqual(["real"]);
    expect(result.population.excluded).toEqual([{ record: prototype, code: "prototype_request" }]);
    expect(result.population.exclusionCounts).toEqual({
      prototype_request: 1,
      invalid_created_at: 0,
    });
  });

  it("excludes requests whose created_at is not a valid instant (7)", () => {
    const invalid = [
      request("date-only", "2026-11-05"),
      request("no-offset", "2026-11-05T10:00:00"),
      request("garbage", "not a date"),
      request("empty", ""),
      { id: "null", status: "submitted", created_at: null as unknown as string },
    ] satisfies EfficiencyRequestRow[];
    const result = volume([request("valid", "2026-11-05T10:00:00Z"), ...invalid]);
    expect(result.value).toBe(1);
    expect(result.population.excluded.map((e) => [e.record.id, e.code])).toEqual(
      invalid.map((r) => [r.id, "invalid_created_at"]),
    );
    expect(result.population.exclusionCounts).toEqual({
      prototype_request: 0,
      invalid_created_at: invalid.length,
    });
  });

  it("gives a prototype with an invalid created_at only prototype_request (8)", () => {
    const both = request("proto-invalid", "not a date");
    const result = volume([], NOVEMBER, [both]);
    expect(result.population.excluded).toEqual([{ record: both, code: "prototype_request" }]);
    expect(result.population.exclusionCounts).toEqual({
      prototype_request: 1,
      invalid_created_at: 0,
    });
  });

  it("counts exclusions over the whole dataset, independent of the period (9)", () => {
    const rows = [
      request("oct", "2026-10-15T12:00:00Z"),
      request("nov", "2026-11-15T12:00:00Z"),
      request("dec", "2026-12-15T12:00:00Z"),
      request("bad-1", "2026-11-15"),
      request("bad-2", "garbage"),
    ];
    const prototypes = [
      request("proto-oct", "2026-10-02T00:00:00Z"),
      request("proto-dec", "2026-12-02T00:00:00Z"),
    ];
    const results = [OCTOBER, NOVEMBER, DECEMBER].map((p) => volume(rows, p, prototypes));
    expect(results.map((r) => r.value)).toEqual([1, 1, 1]);
    for (const result of results) {
      expect(result.population.exclusionCounts).toEqual({
        prototype_request: 2,
        invalid_created_at: 2,
      });
      expect(result.population.inScope).toBe(rows.length + prototypes.length);
      expect(ids(result.population.included)).toEqual(["oct", "nov", "dec"]);
    }
    // A period containing none of the records still reports the same counts.
    const empty = volume(rows, monthPeriod("2027-03"), prototypes);
    expect(empty.value).toBe(0);
    expect(empty.population.exclusionCounts).toEqual(results[0].population.exclusionCounts);
  });
});

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

describe("Request Volume empty results", () => {
  it("returns the number 0, not no-data, for a complete empty dataset (10)", () => {
    const result = volume([]);
    expect(result.value).toBe(0);
    expect(typeof result.value).toBe("number");
    expect(result).not.toHaveProperty("kind");
    expect(result.population).toEqual({
      inScope: 0,
      included: [],
      excluded: [],
      exclusionCounts: { prototype_request: 0, invalid_created_at: 0 },
      flagged: [],
      flagCounts: {},
    });
  });

  it("returns 0 when every request is excluded or outside the period", () => {
    expect(
      volume([request("bad", "garbage")], NOVEMBER, [request("p", NOVEMBER.startUtc)]).value,
    ).toBe(0);
    expect(volume([request("oct", "2026-10-15T12:00:00Z")]).value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Load gating
// ---------------------------------------------------------------------------

describe("Request Volume load gating", () => {
  const rows = [request("r1", "2026-11-05T10:00:00Z"), request("r2", "2026-11-06T10:00:00Z")];

  it("calculates when the stage read failed, was incomplete or missed a field (11)", () => {
    for (const stages of [
      failed<EfficiencyStageRow>("access"),
      failed<EfficiencyStageRow>("unavailable"),
      incomplete<EfficiencyStageRow>(),
      fieldMissing<EfficiencyStageRow>("completed_at"),
    ]) {
      const loaded = load(complete(rows), stages);
      expect(loaded.status).toBe("blocked");
      const result = calculated(calculateRequestVolume({ load: loaded, period: NOVEMBER }));
      expect(result.value).toBe(2);
    }
  });

  it("calculates when stages reference requests that were not loaded (stage_request_not_loaded)", () => {
    const loaded = load(complete(rows), complete([stage("missing-request")]));
    expect(loaded).toMatchObject({ status: "blocked", errors: ["stage_request_not_loaded"] });
    expect(calculated(calculateRequestVolume({ load: loaded, period: NOVEMBER })).value).toBe(2);
  });

  it("blocks on a failed, incomplete or field-missing request read, whatever the stage read (12)", () => {
    const cases = [
      {
        read: failed<EfficiencyRequestRow>("access"),
        error: "request_read_failed",
        issue: "access",
      },
      {
        read: failed<EfficiencyRequestRow>("unavailable"),
        error: "request_read_failed",
        issue: "unavailable",
      },
      { read: incomplete<EfficiencyRequestRow>(), error: "request_read_incomplete", issue: null },
      {
        read: fieldMissing<EfficiencyRequestRow>("created_at"),
        error: "request_field_missing",
        issue: null,
      },
    ] as const;
    for (const { read, error, issue } of cases) {
      for (const stages of [complete([stage("r1")]), failed<EfficiencyStageRow>("unavailable")]) {
        const loaded = load(read, stages);
        const result = calculateRequestVolume({ load: loaded, period: NOVEMBER });
        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") continue;
        expect(result.errors).toEqual([error]);
        expect(result.incompleteTables).toEqual(["financial_requests"]);
        expect(result.issue?.kind ?? null).toBe(issue);
        // Blocked is never turned into a value, zero or no-data.
        expect(result).not.toHaveProperty("value");
        expect(result).not.toHaveProperty("population");
        // It is gateMetricLoad's own result, details intact.
        expect(result).toEqual(gateMetricLoad("request_volume", loaded));
      }
    }
  });

  it("stays cancelled when either read was cancelled (13)", () => {
    for (const loaded of [
      load(cancelled(), complete([])),
      load(complete(rows), cancelled()),
      load(failed("access"), cancelled()),
    ]) {
      expect(calculateRequestVolume({ load: loaded, period: NOVEMBER })).toEqual({
        status: "cancelled",
        metricId: "request_volume",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("Request Volume flags", () => {
  it("never removes an eligible request because of flags (14)", () => {
    // These stages would be flagged in stage metrics (duplicate_active_stages,
    // unknown_queue); Request Volume has no flags and does not read stages.
    const pending = request("pending", "2026-11-05T10:00:00Z", "under_review");
    const stages = [
      stage("pending", { status: "active", completed_at: null, stage_order: 1 }),
      stage("pending", { status: "active", completed_at: null, stage_order: 2 }),
      stage("pending", { status: "active", completed_at: null, queue_id: "retired_queue" }),
    ];
    const result = calculated(
      calculateRequestVolume({ load: loadOf([pending], stages), period: NOVEMBER }),
    );
    expect(result.value).toBe(1);
    expect(result.counted).toEqual([pending]);
    expect(result.population.flagged).toEqual([]);
    expect(result.population.flagCounts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Prototype ownership
// ---------------------------------------------------------------------------

describe("Request Volume prototype ownership", () => {
  type OwnedPrototype = EfficiencyRequestRow & { readonly ownerId: string };
  const browserPrototypes: OwnedPrototype[] = [
    { ...request("proto-a1", "2026-11-03T00:00:00Z"), ownerId: "user-a" },
    { ...request("proto-b1", "2026-11-04T00:00:00Z"), ownerId: "user-b" },
    { ...request("proto-a2", "2026-11-05T00:00:00Z"), ownerId: "user-a" },
  ];

  it("counts exactly the prototypes the caller supplied, so owner scoping stays with the caller (15)", () => {
    const rows = [request("real", "2026-11-05T10:00:00Z")];
    const ownerScoped = browserPrototypes.filter((p) => p.ownerId === "user-a");
    const result = volume(rows, NOVEMBER, ownerScoped);
    expect(ids(result.population.excluded.map((e) => e.record))).toEqual(["proto-a1", "proto-a2"]);
    expect(result.population.exclusionCounts.prototype_request).toBe(2);
    // The function adds no prototypes of its own and never counts one in the value.
    expect(volume(rows, NOVEMBER).population.exclusionCounts.prototype_request).toBe(0);
    expect(result.value).toBe(1);
  });

  it("documents the caller's owner-scoping responsibility on the public function", () => {
    const source = readFileSync(new URL("./efficiency-request-volume.ts", import.meta.url), "utf8");
    const doc = source.slice(0, source.indexOf("export function calculateRequestVolume"));
    expect(doc).toMatch(/caller MUST scope them\s+\* to the signed-in owner/);
  });
});

// ---------------------------------------------------------------------------
// Guards and purity
// ---------------------------------------------------------------------------

describe("Request Volume guards and purity", () => {
  it("throws for invalid period bounds instead of returning 0", () => {
    const loaded = loadOf([request("r1", "2026-11-05T10:00:00Z")]);
    const bad: PeriodBounds[] = [
      { startUtc: "garbage", endExclusiveUtc: NOVEMBER.endExclusiveUtc },
      { startUtc: NOVEMBER.startUtc, endExclusiveUtc: "2026-12-01" },
      { startUtc: NOVEMBER.endExclusiveUtc, endExclusiveUtc: NOVEMBER.startUtc },
      { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.startUtc },
    ];
    for (const period of bad) {
      expect(() => calculateRequestVolume({ load: loaded, period })).toThrow(RangeError);
    }
    // The period is checked even when the load would be blocked or cancelled.
    expect(() => calculateRequestVolume({ load: load(cancelled()), period: bad[0] })).toThrow(
      RangeError,
    );
  });

  it("throws when request ids repeat, since a validated F19.3 load cannot contain duplicates", () => {
    const row = request("dup", "2026-11-05T10:00:00Z");
    const handBuilt: DatasetIntegrityResult = {
      status: "complete",
      dataset: {
        requests: [row, { ...row }],
        stages: [],
        consistency: "per-table-validated",
        reads: { financial_requests: WINDOW, approval_stage_tracking: WINDOW },
      },
    };
    expect(() => calculateRequestVolume({ load: handBuilt, period: NOVEMBER })).toThrow(/dup/);
  });

  it("does not modify its inputs and returns the caller's own records in frozen containers", () => {
    const rows = [
      request("r1", "2026-11-05T10:00:00Z"),
      request("bad", "garbage"),
      request("oct", "2026-10-05T10:00:00Z"),
    ];
    const prototypes = [request("proto", "2026-11-05T10:00:00Z")];
    const loaded = loadOf(rows, [stage("r1")]);
    const period = { startUtc: NOVEMBER.startUtc, endExclusiveUtc: NOVEMBER.endExclusiveUtc };
    const before = snapshot({ loaded, period, prototypes });

    const result = calculated(
      calculateRequestVolume({ load: loaded, period, prototypeRequests: prototypes }),
    );

    expect(snapshot({ loaded, period, prototypes })).toEqual(before);
    expect(result.counted[0]).toBe(rows[0]);
    expect(result.population.included[1]).toBe(rows[2]);
    expect(result.population.excluded.map((e) => e.record)).toEqual([rows[1], prototypes[0]]);
    expect(result.population.excluded[0].record).toBe(rows[1]);
    for (const value of [
      result,
      result.counted,
      result.period,
      result.population,
      result.population.included,
      result.population.excluded,
      result.population.exclusionCounts,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(result.period).not.toBe(period);
  });

  it("calculates nothing else: the result carries only the count and its population", () => {
    expect(Object.keys(volume([]))).toEqual([
      "status",
      "metricId",
      "catalogVersion",
      "period",
      "value",
      "counted",
      "population",
    ]);
  });

  it("imports only the F19.3 types, the shared calculation steps, classification, the catalog and F18 types", () => {
    const source = readFileSync(new URL("./efficiency-request-volume.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[0]);
    expect(imports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1])).toEqual([
      "@/lib/efficiency-data",
      "@/lib/efficiency-calculation",
      "@/lib/efficiency-classification",
      "@/lib/efficiency-metrics",
      "@/lib/time-zones",
    ]);
    expect(imports[0]).toMatch(/^import type /);
    expect(source).not.toMatch(/supabase|efficiency-data-loader|react/i);
    for (const file of [
      "./efficiency-metrics.ts",
      "./efficiency-data.ts",
      "./efficiency-data-loader.ts",
      "./efficiency-population.ts",
      "./efficiency-classification.ts",
      "./efficiency-calculation.ts",
      "./efficiency-stats.ts",
      "./reporting-periods.ts",
      "./time-zones.ts",
      "./date-range-filter.ts",
    ]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(
        /efficiency-request-volume/,
      );
    }
  });
});
