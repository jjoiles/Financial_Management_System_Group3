/**
 * F19.5.5 synthetic scenario verification of all eight F19 metrics.
 *
 * Default mode (`npx vitest run verification/f19_5_5`): every scenario in
 * scenarios.ts goes through the real F19.3 reader and integrity check and the
 * public calculateEfficiencyMetrics entry point, and is compared leaf by leaf
 * with its hand-derived expectation.
 *
 * Database mode (F19_5_5_DB_DIR set by db/run.sh): additionally, the
 * database-backed scenarios are read back from a disposable database
 * (exported as JSON in an America/New_York session) and compared with both
 * the hand expectations and the independent F19.5.2 SQL output.
 *
 * F19_5_5_REPORT_DIR, when set, receives results.json and report.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { calculateEfficiencyMetrics } from "../../src/lib/efficiency-analytics";
import { EFFICIENCY_METRICS, EFFICIENCY_METRIC_IDS } from "../../src/lib/efficiency-metrics";
import { toValidInstant } from "../../src/lib/time-zones";
import dbFixtures from "./fixtures/db-scenarios.json";
import {
  RECOGNIZED,
  SqlOutputError,
  buildLoad,
  compare,
  directLoad,
  expand,
  flattenReport,
  flattenSql,
  type Comparison,
  type Flat,
  type LoadSpec,
} from "./harness";
import { PERIODS, SCENARIOS, type PeriodKey, type Scenario } from "./scenarios";

/** Written independently of the catalog constant: the version F19.5.4.2 introduced. */
const EXPECTED_CATALOG_VERSION = "2026-11-19.2";

type Result = {
  scenario: string;
  period: string;
  source: string;
  comparisons: Comparison[];
  actual?: Flat;
};
const results: Result[] = [];
const record = (result: Result) => {
  results.push(result);
  const failures = result.comparisons.filter((c) => !c.ok);
  expect(failures, `${result.scenario} ${result.period} (${result.source})`).toEqual([]);
};

/** Contract checks the leaf comparison does not cover. */
function contract(
  report: ReturnType<typeof calculateEfficiencyMetrics>,
  load: Awaited<ReturnType<typeof buildLoad>>["load"],
  periodKey: PeriodKey,
): Comparison[] {
  const period = PERIODS[periodKey];
  const out: Comparison[] = [];
  const check = (path: string, expected: unknown, actual: unknown) =>
    out.push({
      path,
      expected: JSON.stringify(expected),
      actual: JSON.stringify(actual),
      ok: JSON.stringify(expected) === JSON.stringify(actual),
    });
  check("report.catalogVersion", EXPECTED_CATALOG_VERSION, report.catalogVersion);
  check("report.period", period, report.period);
  check("report.metricIds", [...EFFICIENCY_METRIC_IDS], Object.keys(report.metrics));
  for (const id of EFFICIENCY_METRIC_IDS) {
    const m = report.metrics[id] as unknown as Record<string, unknown>;
    if (m.status !== "cancelled") check(`${id}.metricId`, id, m.metricId);
    if (m.status !== "calculated") continue;
    check(`${id}.catalogVersion`, EXPECTED_CATALOG_VERSION, m.catalogVersion);
    if (id === "active_queue_workload") {
      check(`${id}.period (snapshot has none)`, undefined, m.period);
      if (load.status === "complete") check(`${id}.snapshot`, load.dataset.reads, m.snapshot);
    } else {
      check(`${id}.period`, period, m.period);
    }
  }
  return out;
}

async function run(scenario: Scenario, spec: LoadSpec, periodKey: PeriodKey) {
  const built = await buildLoad(spec);
  const report = calculateEfficiencyMetrics({
    load: built.load,
    period: PERIODS[periodKey],
    prototypeRequests: scenario.prototypes,
  });
  return { built, report, flat: flattenReport(report) };
}

describe("F19.5.5 synthetic scenarios: public entry point vs hand-derived expectations", () => {
  for (const scenario of SCENARIOS) {
    for (const [periodKey, expected] of Object.entries(scenario.expected) as [
      PeriodKey,
      NonNullable<Scenario["expected"][PeriodKey]>,
    ][]) {
      it(`${scenario.id} [${periodKey}]: ${scenario.description}`, async () => {
        const { built, report, flat } = await run(scenario, scenario.load, periodKey);
        record({
          scenario: scenario.id,
          period: periodKey,
          source: "typescript vs hand",
          comparisons: [
            ...compare(expand(expected), flat),
            ...contract(report, built.load, periodKey),
          ],
          actual: flat,
        });
      });
    }
  }
});

describe("determinism: page sizes and row order", () => {
  const complete = SCENARIOS.filter((s) => !s.id.startsWith("L-"));
  for (const scenario of complete) {
    it(`${scenario.id}: page sizes 1, 2, 7 and reversed / rotated row order give identical results`, async () => {
      const periodKey = Object.keys(scenario.expected)[0] as PeriodKey;
      const baseline = (await run(scenario, scenario.load, periodKey)).flat;
      const comparisons: Comparison[] = [];
      for (const pageSize of [1, 2, 7]) {
        const { flat } = await run(scenario, { ...scenario.load, pageSize }, periodKey);
        comparisons.push(
          ...compare(baseline, flat).map((c) => ({
            ...c,
            path: `pageSize ${pageSize}: ${c.path}`,
          })),
        );
      }
      const reqRows = scenario.load.requests.rows;
      const stgRows = scenario.load.stages.rows;
      const rotate = <T>(rows: readonly T[]) =>
        rows.length > 1 ? [...rows.slice(1), rows[0]] : [...rows];
      for (const [label, r, s] of [
        ["reversed", [...reqRows].reverse(), [...stgRows].reverse()],
        ["rotated", rotate(reqRows), rotate(stgRows)],
      ] as const) {
        const report = calculateEfficiencyMetrics({
          load: directLoad(r, s),
          period: PERIODS[periodKey],
          prototypeRequests: scenario.prototypes,
        });
        comparisons.push(
          ...compare(baseline, flattenReport(report)).map((c) => ({
            ...c,
            path: `${label}: ${c.path}`,
          })),
        );
      }
      record({ scenario: scenario.id, period: periodKey, source: "determinism", comparisons });
    });
  }
});

describe("additional properties", () => {
  it("T-W: queue totals differ from the distinct request count", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "T-W")!;
    const { report } = await run(scenario, scenario.load, "nov");
    const workload = report.metrics.active_queue_workload;
    if (workload.status !== "calculated") throw new Error("workload not calculated");
    const queueTotal =
      Object.values(workload.queues.recognized).reduce((a, b) => a + b, 0) +
      (workload.queues.unknown ?? 0);
    const distinct = new Set(workload.counted.map((stage) => stage.request_id)).size;
    record({
      scenario: "T-W",
      period: "nov",
      source: "queue sum vs distinct",
      comparisons: [
        { path: "sum of queue counts", expected: 5, actual: queueTotal, ok: queueTotal === 5 },
        { path: "distinct counted requests", expected: 4, actual: distinct, ok: distinct === 4 },
      ],
    });
  });

  it("S5: throughput counts stage decisions (4), not distinct requests (3)", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "S5")!;
    const { report } = await run(scenario, scenario.load, "nov");
    const throughput = report.metrics.queue_throughput;
    if (throughput.status !== "calculated") throw new Error("throughput not calculated");
    const distinct = new Set(throughput.counted.map((stage) => stage.request_id)).size;
    record({
      scenario: "S5",
      period: "nov",
      source: "throughput decisions vs requests",
      comparisons: [
        { path: "overall", expected: 4, actual: throughput.overall, ok: throughput.overall === 4 },
        { path: "distinct requests", expected: 3, actual: distinct, ok: distinct === 3 },
      ],
    });
  });

  it("repeated ids in a supplied complete load are a programming error (throws), never a value", () => {
    const rows = SCENARIOS.find((s) => s.id === "S5")!.load;
    const duplicated = directLoad([...rows.requests.rows, rows.requests.rows[0]], rows.stages.rows);
    expect(() => calculateEfficiencyMetrics({ load: duplicated, period: PERIODS.nov })).toThrow(
      /ids repeat/,
    );
  });

  it("an invalid period throws a RangeError, even for a cancelled load", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "L-CANCELLED")!;
    const { load } = await buildLoad(scenario.load);
    const reversed = {
      startUtc: PERIODS.nov.endExclusiveUtc,
      endExclusiveUtc: PERIODS.nov.startUtc,
    };
    expect(() => calculateEfficiencyMetrics({ load, period: reversed })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// flattenSql: strict parsing of the F19.5.2 output
// ---------------------------------------------------------------------------

/**
 * A complete F19.5.2 output in the SQL's own row format (psql -At -F tab):
 * non-result sections, every result row, and the SUMMARY rows. Values are an
 * empty dataset except where `overrides` (keyed "metric|measure") replace the
 * expected column.
 */
function sqlOutput(overrides: Record<string, string> = {}): string[] {
  const rows: string[][] = [];
  const row = (metric: string, measure: string, expected: string) =>
    rows.push([
      metric,
      measure,
      overrides[`${metric}|${measure}`] ?? expected,
      "0",
      "yes",
      "(null)",
    ]);
  const exclusions = (metric: string, codes: readonly string[]) =>
    codes.forEach((code, i) => row(metric, `${i + 1}. exclusion ${code}`, "0"));
  const codes = (id: keyof typeof EFFICIENCY_METRICS) =>
    EFFICIENCY_METRICS[id].population.conditions.map((c) => c.exclusion);
  const tracked = "tracked_terminal (turnaround_*, approval_rate)";

  row("dataset", "financial_requests records", "0");
  row("dataset", "approval_stage_tracking records", "0");
  row("dataset", "stages whose request is not stored", "0");
  row("request_volume", "value (requests, created_at in period)", "0");
  row("request_volume", "population in scope / included", "0 / 0");
  row("request_volume", "probe: October 2026 UTC [10-01, 11-01)", "0");
  row("request_volume", "flags", "none defined");
  for (const q of RECOGNIZED) row("active_queue_workload", `queue ${q} (distinct requests)`, "0");
  row("active_queue_workload", "unknown group (distinct requests)", "absent");
  row("active_queue_workload", "population in scope / included (active stages)", "0 / 0");
  row("active_queue_workload", "flag duplicate_active_stages (requests)", "0");
  row("active_queue_workload", "flag unknown_queue (stages)", "0");
  row("active_queue_workload", "separate report pending_without_stage", "0");
  row("active_queue_workload", "overall value", "not defined");
  for (const id of ["stage_processing_time_average", "stage_processing_time_median"]) {
    row(id, "overall (n=0)", "no-data");
    for (const q of RECOGNIZED) row(id, `${q} (n=0)`, "no-data");
  }
  row("stage_processing_time_*", "unknown group", "absent");
  row("stage_processing_time_*", "population in scope / included (full dataset)", "0 / 0");
  row("stage_processing_time_*", "flag unknown_queue (included stages, full dataset)", "0");
  row("request_turnaround_time_average", "value (hours, n=0)", "no-data");
  row("request_turnaround_time_median", "value (hours, n=0)", "no-data");
  row(tracked, "population in scope / included (full dataset)", "0 / 0");
  row(tracked, "decisive stage: staged requests / unique highest pair", "0 / 0");
  row(tracked, "decisive stage: ties at highest pair / invalid keys", "0 / 0");
  row(tracked, "requests that would tie on stage_order alone", "0");
  row("request_turnaround_time_*", "flags", "none defined");
  row("approval_rate", "approved (A)", "0");
  row("approval_rate", "rejected (R)", "0");
  row("approval_rate", "denominator (A + R)", "0");
  row("approval_rate", "value A / (A + R)", "no-data");
  for (const q of RECOGNIZED) row("queue_throughput", `queue ${q} (stage decisions)`, "0");
  row("queue_throughput", "unknown group (stage decisions)", "absent");
  row("queue_throughput", "overall total (stage records, not requests)", "0");
  row("queue_throughput", "population in scope / included (full dataset)", "0 / 0");
  row("queue_throughput", "flag unknown_queue (included stages, full dataset)", "0");
  exclusions("request_volume", codes("request_volume"));
  exclusions("active_queue_workload", codes("active_queue_workload"));
  exclusions(
    "active_queue_workload:pending_without_stage",
    EFFICIENCY_METRICS.active_queue_workload.separateReports[0].population.conditions.map(
      (c) => c.exclusion,
    ),
  );
  exclusions("stage_processing_time_*", codes("stage_processing_time_average"));
  exclusions(tracked, codes("approval_rate"));
  exclusions("queue_throughput", codes("queue_throughput"));
  row("dataset", "SUMMARY: rows agreeing with F19.5.1", "3 of 3");
  row("ALL", "SUMMARY: rows agreeing with F19.5.1", "78 of 78");
  return [
    "== 0. Session and reporting period ==",
    "on\ton\tUTC\t2026-11-01 00:00:00+00\t2026-12-01 00:00:00+00\thalf-open\t20261119130000",
    "financial_requests\tid\tuuid\tt",
    "financial_requests\tapproved\t7",
    ...rows.map((cols) => cols.join("\t")),
    "Done. Rolling back (nothing was written).",
  ];
}

describe("flattenSql: strict parsing of the F19.5.2 output", () => {
  const parse = (lines: string[]) => flattenSql(lines.join("\n"));

  it("parses a complete output, including the stage-time unknown group, and ignores non-result sections", () => {
    const sql = parse(
      sqlOutput({
        "request_volume|value (requests, created_at in period)": "4",
        "approval_rate|approved (A)": "2",
        "approval_rate|rejected (R)": "1",
        "approval_rate|denominator (A + R)": "3",
        "approval_rate|value A / (A + R)": "0.6666666666666666",
        "stage_processing_time_average|overall (n=0)": "no-data",
      }),
    );
    expect(sql["request_volume.value"]).toBe(4);
    expect(sql["approval_rate.value"]).toBeCloseTo(2 / 3, 15);
    expect(sql["stage_processing_time_median.queues.unknown.n"]).toBeNull();
    expect(sql["active_queue_workload.queues.unknown"]).toBeNull();
    expect(sql["request_turnaround_time_average.exclusions.decision_before_creation"]).toBe(0);
    expect(Object.keys(sql).length).toBeGreaterThan(100);
  });

  it("rejects an unrecognized result row instead of skipping it", () => {
    const lines = sqlOutput();
    lines.splice(10, 0, "queue_throughput\tmedian decisions per day\t3\t0\tyes\t(null)");
    expect(() => parse(lines)).toThrow(SqlOutputError);
    expect(() => parse(lines)).toThrow(/unrecognized result row.*median decisions per day/);
  });

  it("rejects a result row with the wrong number of columns", () => {
    const lines = sqlOutput().map((line) =>
      line.startsWith("approval_rate\tapproved (A)")
        ? "approval_rate\tapproved (A)\t0\t0\tyes"
        : line,
    );
    expect(() => parse(lines)).toThrow(/has 5 columns, expected 6/);
  });

  it("rejects a count or statistic that is not a number", () => {
    expect(() =>
      parse(sqlOutput({ "queue_throughput|overall total (stage records, not requests)": "four" })),
    ).toThrow(/"four" is not a count/);
    expect(() =>
      parse(sqlOutput({ "request_turnaround_time_median|value (hours, n=0)": "NaN" })),
    ).toThrow(/is not a number or no-data/);
    expect(() =>
      parse(sqlOutput({ "request_volume|population in scope / included": "3 of 2" })),
    ).toThrow(/<in scope> \/ <included>/);
  });

  it("rejects output with a required value missing", () => {
    const lines = sqlOutput().filter(
      (line) => !line.startsWith("queue_throughput\tqueue dean_office"),
    );
    expect(() => parse(lines)).toThrow(
      /missing 1 required value\(s\): queue_throughput\.queues\.dean_office/,
    );
  });

  it("rejects truncated output without the final ALL summary row", () => {
    const lines = sqlOutput().filter((line) => !line.startsWith("ALL\t"));
    expect(() => parse(lines)).toThrow(/ALL \| SUMMARY.*truncated/);
  });

  it("rejects text that contains no result rows", () => {
    expect(() => parse(["== 0. Session ==", "on\ton\tUTC"])).toThrow(/no result rows/);
  });

  it("rejects an informational row whose fixed text changed, such as a new flag", () => {
    expect(() => parse(sqlOutput({ "request_volume|flags": "unknown_queue" }))).toThrow(
      /expected "none defined"/,
    );
  });

  it("rejects a stage-time unknown group that is not absent, and an unknown queue id", () => {
    expect(() => parse(sqlOutput({ "stage_processing_time_*|unknown group": "12.5" }))).toThrow(
      /only parsed as "absent"/,
    );
    const lines = sqlOutput().map((line) =>
      line.replace("queue_throughput\tqueue cfo_office (", "queue_throughput\tqueue procurement ("),
    );
    expect(() => parse(lines)).toThrow(/"procurement" is not a recognized queue/);
  });

  it("rejects duplicate values and an approval denominator that is not A + R", () => {
    const lines = sqlOutput();
    const approved = lines.find((line) => line.startsWith("approval_rate\tapproved (A)"))!;
    expect(() => parse([...lines.slice(0, -1), approved, lines[lines.length - 1]])).toThrow(
      /duplicate value for approval_rate\.approved/,
    );
    expect(() => parse(sqlOutput({ "approval_rate|denominator (A + R)": "5" }))).toThrow(
      /denominator 5 is not approved 0 \+ rejected 0/,
    );
  });
});

// ---------------------------------------------------------------------------
// Database mode
// ---------------------------------------------------------------------------

const DB_DIR = process.env.F19_5_5_DB_DIR;

describe.runIf(Boolean(DB_DIR))(
  "database-backed scenarios: disposable database export and independent SQL",
  () => {
    for (const scenario of SCENARIOS.filter((s) => s.db)) {
      const key = scenario.db!;
      it(`${scenario.id}: export preserves every fixture instant (JSON with non-UTC offsets)`, () => {
        const exported = JSON.parse(readFileSync(`${DB_DIR}/export_${key}.json`, "utf8"));
        const fixture = (
          dbFixtures.scenarios as Record<
            string,
            { requests: Record<string, unknown>[]; stages: Record<string, unknown>[] }
          >
        )[key];
        const comparisons: Comparison[] = [];
        for (const table of ["requests", "stages"] as const) {
          const exportedRows = exported[
            table === "requests" ? "financial_requests" : "approval_stage_tracking"
          ] as Record<string, unknown>[];
          comparisons.push({
            path: `${table}.count`,
            expected: fixture[table].length,
            actual: exportedRows.length,
            ok: fixture[table].length === exportedRows.length,
          });
          for (const row of fixture[table]) {
            const match = exportedRows.find((r) => r.id === row.id);
            const loaderColumns =
              table === "requests"
                ? ["status", "created_at"]
                : [
                    "request_id",
                    "workflow_revision",
                    "stage_order",
                    "queue_id",
                    "status",
                    "started_at",
                    "completed_at",
                  ];
            for (const field of loaderColumns) {
              const a = row[field];
              const b = match?.[field];
              const ms = (v: unknown) =>
                typeof v === "string" ? (toValidInstant(v)?.getTime() ?? v) : v;
              const ok = field.endsWith("_at")
                ? ms(a) === ms(b) && (b === null || /-0[45]:00$/.test(String(b)))
                : a === b;
              comparisons.push({
                path: `${table}.${row.label}.${field}`,
                expected: String(a),
                actual: String(b),
                ok,
              });
            }
          }
        }
        record({ scenario: scenario.id, period: "-", source: "database export", comparisons });
      });

      for (const periodKey of Object.keys(scenario.expected) as PeriodKey[]) {
        it(`${scenario.id} [${periodKey}]: SQL and TypeScript over the database rows match the hand expectation`, async () => {
          const exported = JSON.parse(readFileSync(`${DB_DIR}/export_${key}.json`, "utf8"));
          const expected = expand(scenario.expected[periodKey]!);
          const sql = flattenSql(readFileSync(`${DB_DIR}/sql_${key}_${periodKey}.tsv`, "utf8"));
          const sqlExpected = Object.fromEntries(
            Object.keys(sql).map((path) => [path, expected[path]]),
          );
          expect(Object.keys(sql).length).toBeGreaterThan(40);
          record({
            scenario: scenario.id,
            period: periodKey,
            source: "sql vs hand",
            comparisons: compare(sqlExpected, sql, false),
          });

          const spec: LoadSpec = {
            requests: {
              rows: exported.financial_requests,
              count: exported.counts.financial_requests,
            },
            stages: {
              rows: exported.approval_stage_tracking,
              count: exported.counts.approval_stage_tracking,
            },
          };
          const { built, report, flat } = await run(scenario, spec, periodKey);
          record({
            scenario: scenario.id,
            period: periodKey,
            source: "typescript (database rows) vs hand",
            comparisons: [...compare(expected, flat), ...contract(report, built.load, periodKey)],
            actual: flat,
          });
        });
      }
    }
  },
);

afterAll(() => {
  const dir = process.env.F19_5_5_REPORT_DIR;
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const totals = {
    runs: results.length,
    comparisons: results.reduce((n, r) => n + r.comparisons.length, 0),
    mismatches: results.reduce((n, r) => n + r.comparisons.filter((c) => !c.ok).length, 0),
    databaseMode: Boolean(DB_DIR),
  };
  writeFileSync(`${dir}/results.json`, JSON.stringify({ totals, results }, null, 2));
  const bySource = new Map<string, { runs: number; comparisons: number; mismatches: number }>();
  for (const r of results) {
    const s = bySource.get(r.source) ?? { runs: 0, comparisons: 0, mismatches: 0 };
    s.runs += 1;
    s.comparisons += r.comparisons.length;
    s.mismatches += r.comparisons.filter((c) => !c.ok).length;
    bySource.set(r.source, s);
  }
  const lines = [
    "# F19.5.5 comparison report",
    "",
    `Database mode: ${totals.databaseMode ? "yes" : "no"}. Runs: ${totals.runs}. Leaf comparisons: ${totals.comparisons}. Mismatches: ${totals.mismatches}.`,
    "",
    "| Source | Runs | Comparisons | Mismatches |",
    "| --- | --- | --- | --- |",
    ...[...bySource].map(
      ([source, s]) => `| ${source} | ${s.runs} | ${s.comparisons} | ${s.mismatches} |`,
    ),
    "",
    "| Scenario | Period | Source | Comparisons | Mismatches |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.period} | ${r.source} | ${r.comparisons.length} | ${r.comparisons.filter((c) => !c.ok).length} |`,
    ),
    "",
  ];
  const mismatched = results.flatMap((r) =>
    r.comparisons
      .filter((c) => !c.ok)
      .map(
        (c) =>
          `- ${r.scenario} ${r.period} ${r.source}: ${c.path} expected ${c.expected} got ${c.actual}`,
      ),
  );
  if (mismatched.length > 0) lines.push("## Mismatches", "", ...mismatched, "");
  writeFileSync(`${dir}/report.md`, lines.join("\n"));
});
