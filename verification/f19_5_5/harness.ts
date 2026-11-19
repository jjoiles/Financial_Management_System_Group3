/**
 * F19.5.5 harness: builds F19.3 loads from synthetic rows through the real
 * paginated reader (readAllPages) and integrity check (checkDatasetIntegrity),
 * normalises calculateEfficiencyMetrics results, expands hand-written
 * expectations, converts the independent F19.5.2 SQL output, and compares
 * them leaf by leaf.
 *
 * Nothing here calculates a metric value. Expected values come from
 * scenarios.ts (hand calculations) and, for the database-backed scenarios,
 * from verification/f19_5_2_metric_verification.sql.
 */
import { calculateEfficiencyMetrics } from "../../src/lib/efficiency-analytics";
import {
  DEFAULT_PAGE_SIZE,
  EFFICIENCY_REQUEST_COLUMNS,
  EFFICIENCY_STAGE_COLUMNS,
  checkDatasetIntegrity,
  readAllPages,
  type DatasetIntegrityResult,
  type EfficiencyRequestRow,
  type EfficiencyStageRow,
  type FetchCount,
  type FetchPage,
  type TableReadResult,
} from "../../src/lib/efficiency-data";
import type { EfficiencyLoadResult } from "../../src/lib/efficiency-data-loader";
import {
  EFFICIENCY_METRICS,
  EFFICIENCY_METRIC_IDS,
  type EfficiencyMetricId,
} from "../../src/lib/efficiency-metrics";
import { QUEUES } from "../../src/lib/routing/rules";
import type { PeriodBounds } from "../../src/lib/time-zones";

export const RECOGNIZED = Object.keys(QUEUES);
export type Leaf = string | number | boolean | null;
export type Flat = Record<string, Leaf>;

// ---------------------------------------------------------------------------
// Loads through the real F19.3 reader
// ---------------------------------------------------------------------------

/** How a synthetic table read behaves. Rows are served in key order, like the loader's keyset pages. */
export type TableSpec = {
  readonly rows: readonly object[];
  /** Exact count the server reports (default: rows.length). */
  readonly count?: number;
  /** Error returned by every page request. */
  readonly pageError?: unknown;
  /** Rows actually served (default: all); the count still reports `count`. */
  readonly serve?: (row: Record<string, unknown>) => boolean;
  /** Serve at most this many rows in total (a server row cap). */
  readonly rowCap?: number;
  /** Repeat the first row of the first page (a broken page). */
  readonly duplicateFirst?: boolean;
  /** Remove this column from every served row (a missing select column). */
  readonly omitField?: string;
};

const byId = (a: object, b: object) => {
  const x = (a as { id: string }).id;
  const y = (b as { id: string }).id;
  return x < y ? -1 : x > y ? 1 : 0;
};

function fetchers(spec: TableSpec): { fetchPage: FetchPage; fetchCount: FetchCount } {
  let served = [...spec.rows].sort(byId) as Record<string, unknown>[];
  if (spec.serve) served = served.filter(spec.serve);
  if (spec.rowCap !== undefined) served = served.slice(0, spec.rowCap);
  if (spec.omitField) {
    const field = spec.omitField;
    served = served.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => k !== field)),
    );
  }
  return {
    fetchPage: async ({ after, limit }) => {
      if (spec.pageError !== undefined) return { data: null, error: spec.pageError };
      const remaining = served.filter((row) => after === null || (row.id as string) > after);
      let page = remaining.slice(0, limit);
      if (spec.duplicateFirst && after === null && page.length > 0)
        page = [page[0], ...page].slice(0, limit);
      return { data: JSON.parse(JSON.stringify(page)), error: null };
    },
    fetchCount: async () => ({ count: spec.count ?? spec.rows.length, error: null }),
  };
}

export type LoadSpec = {
  readonly requests: TableSpec;
  readonly stages: TableSpec;
  readonly pageSize?: number;
  readonly aborted?: boolean;
};

export type BuiltLoad = {
  readonly load: EfficiencyLoadResult;
  readonly requests: TableReadResult<EfficiencyRequestRow>;
  readonly stages: TableReadResult<EfficiencyStageRow>;
};

/** Mirrors loadEfficiencyDataset's sequence (requests, then stages, then the integrity check) with one attempt. */
export async function buildLoad(
  spec: LoadSpec,
  userId = "f1955000-synthetic-user",
): Promise<BuiltLoad> {
  const controller = new AbortController();
  if (spec.aborted) controller.abort();
  const pageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
  const requests = await readAllPages<EfficiencyRequestRow>({
    ...fetchers(spec.requests),
    requiredFields: EFFICIENCY_REQUEST_COLUMNS,
    pageSize,
    signal: controller.signal,
  });
  const stages = await readAllPages<EfficiencyStageRow>({
    ...fetchers(spec.stages),
    requiredFields: EFFICIENCY_STAGE_COLUMNS,
    pageSize,
    signal: controller.signal,
  });
  const integrity: DatasetIntegrityResult = checkDatasetIntegrity({ requests, stages });
  return { load: { ...integrity, userId, attempts: 1 }, requests, stages };
}

/** A complete load built from rows in the given order, bypassing pagination (for ordering checks). */
export function directLoad(
  requests: readonly object[],
  stages: readonly object[],
): DatasetIntegrityResult {
  const window = {
    readStartedAt: "2026-11-19T00:00:00.000Z",
    readCompletedAt: "2026-11-19T00:00:00.000Z",
  };
  const complete = <Row>(rows: readonly object[]): TableReadResult<Row> => ({
    status: "complete",
    rows: rows as Row[],
    expectedCount: rows.length,
    pagesRead: 1,
    window,
  });
  return checkDatasetIntegrity({ requests: complete(requests), stages: complete(stages) });
}

// ---------------------------------------------------------------------------
// Normalising results
// ---------------------------------------------------------------------------

type Stat = { kind: "no-data" } | { kind: "value"; value: number };
const stat = (s: Stat): Leaf => (s.kind === "no-data" ? "no-data" : s.value);
type Population = {
  inScope: number;
  included: readonly unknown[];
  exclusionCounts: Readonly<Record<string, number | undefined>>;
  flagCounts: Readonly<Record<string, number | undefined>>;
};

function population(prefix: string, pop: Population, out: Flat) {
  out[`${prefix}.inScope`] = pop.inScope;
  out[`${prefix}.included`] = pop.included.length;
  for (const [code, n] of Object.entries(pop.exclusionCounts))
    out[`${prefix}.exclusions.${code}`] = n ?? 0;
  for (const [code, n] of Object.entries(pop.flagCounts)) out[`${prefix}.flags.${code}`] = n ?? 0;
}

/** Flattens one calculateEfficiencyMetrics report into comparable leaves. */
export function flattenReport(report: ReturnType<typeof calculateEfficiencyMetrics>): Flat {
  const out: Flat = {};
  for (const id of EFFICIENCY_METRIC_IDS) {
    const r = report.metrics[id] as unknown as Record<string, unknown> & { status: string };
    out[`${id}.status`] = r.status;
    if (r.status === "blocked") {
      out[`${id}.errors`] = (r.errors as string[]).join(",");
      const issue = r.issue as { kind: string } | null;
      out[`${id}.issue`] = issue ? issue.kind : null;
      continue;
    }
    if (r.status !== "calculated") continue;
    const pop = r.population as Population;
    population(id, pop, out);
    switch (id) {
      case "request_volume":
        out[`${id}.value`] = r.value as number;
        break;
      case "active_queue_workload": {
        const queues = r.queues as { recognized: Record<string, number>; unknown?: number };
        for (const q of RECOGNIZED) out[`${id}.queues.${q}`] = queues.recognized[q];
        out[`${id}.queues.unknown`] = queues.unknown ?? null;
        const sep = (r.separateReports as Record<string, { count: number; population: Population }>)
          .pending_without_stage;
        out[`${id}.pending_without_stage.count`] = sep.count;
        population(`${id}.pending_without_stage`, sep.population, out);
        break;
      }
      case "stage_processing_time_average":
      case "stage_processing_time_median": {
        const overall = r.overall as { n: number; value: Stat };
        out[`${id}.overall.n`] = overall.n;
        out[`${id}.overall.value`] = stat(overall.value);
        const queues = r.queues as {
          recognized: Record<string, { n: number; value: Stat }>;
          unknown?: { n: number; value: Stat };
        };
        for (const q of RECOGNIZED) {
          out[`${id}.queues.${q}.n`] = queues.recognized[q].n;
          out[`${id}.queues.${q}.value`] = stat(queues.recognized[q].value);
        }
        out[`${id}.queues.unknown.n`] = queues.unknown ? queues.unknown.n : null;
        out[`${id}.queues.unknown.value`] = queues.unknown ? stat(queues.unknown.value) : null;
        break;
      }
      case "request_turnaround_time_average":
      case "request_turnaround_time_median":
        out[`${id}.n`] = r.n as number;
        out[`${id}.value`] = stat(r.value as Stat);
        break;
      case "approval_rate":
        out[`${id}.approved`] = r.approved as number;
        out[`${id}.rejected`] = r.rejected as number;
        out[`${id}.value`] = stat(r.value as Stat);
        break;
      case "queue_throughput": {
        out[`${id}.overall`] = r.overall as number;
        const queues = r.queues as { recognized: Record<string, number>; unknown?: number };
        for (const q of RECOGNIZED) out[`${id}.queues.${q}`] = queues.recognized[q];
        out[`${id}.queues.unknown`] = queues.unknown ?? null;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expectations: compact hand-written form, expanded with catalog defaults
// ---------------------------------------------------------------------------

export type V = number | "no-data";
type Counts = Partial<Record<string, number>>;
type Pop = { inScope: number; included: number; exclusions?: Counts; flags?: Counts };
export type Blocked = {
  status: "blocked";
  errors: string[];
  issue?: "access" | "unavailable" | null;
};
export type Cancelled = { status: "cancelled" };
type Group = { n: number; value: V };

export type Expected = {
  request_volume: (Pop & { value: number }) | Blocked | Cancelled;
  active_queue_workload:
    | (Pop & {
        queues?: Counts;
        unknown?: number;
        pending_without_stage: { count: number; inScope: number; exclusions?: Counts };
      })
    | Blocked
    | Cancelled;
  stage_processing_time_average:
    | (Pop & { overall: Group; queues?: Partial<Record<string, Group>>; unknown?: Group })
    | Blocked
    | Cancelled;
  stage_processing_time_median:
    | (Pop & { overall: Group; queues?: Partial<Record<string, Group>>; unknown?: Group })
    | Blocked
    | Cancelled;
  request_turnaround_time_average: (Pop & { n: number; value: V }) | Blocked | Cancelled;
  request_turnaround_time_median: (Pop & { n: number; value: V }) | Blocked | Cancelled;
  approval_rate: (Pop & { approved: number; rejected: number; value: V }) | Blocked | Cancelled;
  queue_throughput:
    | (Pop & { overall: number; queues?: Counts; unknown?: number })
    | Blocked
    | Cancelled;
};

const conditionCodes = (id: EfficiencyMetricId) =>
  EFFICIENCY_METRICS[id].population.conditions.map((c) => c.exclusion);
const flagCodes = (id: EfficiencyMetricId) => [...EFFICIENCY_METRICS[id].flags];

function expandPop(
  prefix: string,
  id: EfficiencyMetricId,
  pop: Pop,
  out: Flat,
  codes = conditionCodes(id),
  flags = flagCodes(id),
) {
  out[`${prefix}.inScope`] = pop.inScope;
  out[`${prefix}.included`] = pop.included;
  for (const code of codes) out[`${prefix}.exclusions.${code}`] = pop.exclusions?.[code] ?? 0;
  for (const code of flags) out[`${prefix}.flags.${code}`] = pop.flags?.[code] ?? 0;
  for (const code of Object.keys(pop.exclusions ?? {}))
    if (!(codes as readonly string[]).includes(code))
      throw new Error(`${prefix}: ${code} is not a catalog condition`);
}

/**
 * Expands a compact expectation. Omitted exclusion and flag codes are 0,
 * omitted recognized queues are 0 (counts) or { n: 0, value: "no-data" }
 * (durations), and an omitted unknown group is absent (null).
 */
export function expand(expected: Expected): Flat {
  const out: Flat = {};
  for (const id of EFFICIENCY_METRIC_IDS) {
    const e = expected[id] as Record<string, unknown> & { status?: string };
    if (e.status === "blocked") {
      const b = e as unknown as Blocked;
      out[`${id}.status`] = "blocked";
      out[`${id}.errors`] = b.errors.join(",");
      out[`${id}.issue`] = b.issue ?? null;
      continue;
    }
    if (e.status === "cancelled") {
      out[`${id}.status`] = "cancelled";
      continue;
    }
    out[`${id}.status`] = "calculated";
    expandPop(id, id, e as unknown as Pop, out);
    switch (id) {
      case "request_volume":
        out[`${id}.value`] = e.value as number;
        break;
      case "active_queue_workload": {
        const queues = (e.queues ?? {}) as Counts;
        for (const q of RECOGNIZED) out[`${id}.queues.${q}`] = queues[q] ?? 0;
        out[`${id}.queues.unknown`] = (e.unknown as number | undefined) ?? null;
        const pws = e.pending_without_stage as {
          count: number;
          inScope: number;
          exclusions?: Counts;
        };
        out[`${id}.pending_without_stage.count`] = pws.count;
        const report = EFFICIENCY_METRICS[id].separateReports[0];
        expandPop(
          `${id}.pending_without_stage`,
          id,
          { inScope: pws.inScope, included: pws.count, exclusions: pws.exclusions },
          out,
          report.population.conditions.map((c) => c.exclusion),
          [],
        );
        break;
      }
      case "stage_processing_time_average":
      case "stage_processing_time_median": {
        const overall = e.overall as Group;
        out[`${id}.overall.n`] = overall.n;
        out[`${id}.overall.value`] = overall.value;
        const queues = (e.queues ?? {}) as Partial<Record<string, Group>>;
        for (const q of RECOGNIZED) {
          out[`${id}.queues.${q}.n`] = queues[q]?.n ?? 0;
          out[`${id}.queues.${q}.value`] = queues[q]?.value ?? "no-data";
        }
        const unknown = e.unknown as Group | undefined;
        out[`${id}.queues.unknown.n`] = unknown ? unknown.n : null;
        out[`${id}.queues.unknown.value`] = unknown ? unknown.value : null;
        break;
      }
      case "request_turnaround_time_average":
      case "request_turnaround_time_median":
        out[`${id}.n`] = e.n as number;
        out[`${id}.value`] = e.value as V;
        break;
      case "approval_rate":
        out[`${id}.approved`] = e.approved as number;
        out[`${id}.rejected`] = e.rejected as number;
        out[`${id}.value`] = e.value as V;
        break;
      case "queue_throughput": {
        out[`${id}.overall`] = e.overall as number;
        const queues = (e.queues ?? {}) as Counts;
        for (const q of RECOGNIZED) out[`${id}.queues.${q}`] = queues[q] ?? 0;
        out[`${id}.queues.unknown`] = (e.unknown as number | undefined) ?? null;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Independent SQL output (verification/f19_5_2_metric_verification.sql)
// ---------------------------------------------------------------------------

/** Thrown when the F19.5.2 SQL output does not have the expected shape. */
export class SqlOutputError extends Error {
  constructor(message: string) {
    super(`flattenSql: ${message}`);
    this.name = "SqlOutputError";
  }
}

/** The metric_id values of F19.5.2 result rows (section 8 of the SQL, plus SUMMARY rows). */
const SQL_RESULT_METRICS = [
  "dataset",
  "request_volume",
  "active_queue_workload",
  "active_queue_workload:pending_without_stage",
  "stage_processing_time_*",
  "stage_processing_time_average",
  "stage_processing_time_median",
  "request_turnaround_time_*",
  "request_turnaround_time_average",
  "request_turnaround_time_median",
  "tracked_terminal (turnaround_*, approval_rate)",
  "approval_rate",
  "queue_throughput",
  "ALL",
] as const;
const RESULT_METRICS: ReadonlySet<string> = new Set(SQL_RESULT_METRICS);

/** The leaf paths each SQL population row stands for. */
const SQL_TARGETS: Readonly<Record<string, readonly string[]>> = {
  request_volume: ["request_volume"],
  active_queue_workload: ["active_queue_workload"],
  "active_queue_workload:pending_without_stage": ["active_queue_workload.pending_without_stage"],
  "stage_processing_time_*": ["stage_processing_time_average", "stage_processing_time_median"],
  "tracked_terminal (turnaround_*, approval_rate)": [
    "request_turnaround_time_average",
    "request_turnaround_time_median",
    "approval_rate",
  ],
  queue_throughput: ["queue_throughput"],
};

/**
 * Result rows that carry no value the TypeScript results report. Each is
 * matched exactly, and where its expected text is fixed, that text is
 * checked too, so a change (for example a catalog that adds flags) is an
 * error rather than a silently skipped row.
 */
const INFORMATIONAL_ROWS: readonly {
  readonly metric: string;
  readonly measure: RegExp;
  readonly expected?: string;
}[] = [
  { metric: "dataset", measure: /^financial_requests records$/ },
  { metric: "dataset", measure: /^approval_stage_tracking records$/ },
  { metric: "dataset", measure: /^stages whose request is not stored$/ },
  { metric: "request_volume", measure: /^probe: / },
  { metric: "request_volume", measure: /^flags$/, expected: "none defined" },
  { metric: "request_turnaround_time_*", measure: /^flags$/, expected: "none defined" },
  { metric: "active_queue_workload", measure: /^overall value$/, expected: "not defined" },
  {
    metric: "tracked_terminal (turnaround_*, approval_rate)",
    measure: /^decisive stage: staged requests \/ unique highest pair$/,
  },
  {
    metric: "tracked_terminal (turnaround_*, approval_rate)",
    measure: /^decisive stage: ties at highest pair \/ invalid keys$/,
  },
  {
    metric: "tracked_terminal (turnaround_*, approval_rate)",
    measure: /^requests that would tie on stage_order alone$/,
  },
];

/**
 * Every leaf path a complete F19.5.2 run must produce, so a format change
 * cannot silently reduce the comparison.
 */
function requiredSqlPaths(): string[] {
  const paths: string[] = [];
  const population = (prefix: string, id: EfficiencyMetricId) => {
    paths.push(`${prefix}.inScope`, `${prefix}.included`);
    for (const code of conditionCodes(id)) paths.push(`${prefix}.exclusions.${code}`);
  };
  for (const id of EFFICIENCY_METRIC_IDS) population(id, id);
  for (const code of ["duplicate_active_stages", "unknown_queue"])
    paths.push(`active_queue_workload.flags.${code}`);
  for (const id of ["stage_processing_time_average", "stage_processing_time_median"] as const) {
    paths.push(`${id}.flags.unknown_queue`, `${id}.overall.n`, `${id}.overall.value`);
    for (const q of [...RECOGNIZED, "unknown"])
      paths.push(`${id}.queues.${q}.n`, `${id}.queues.${q}.value`);
  }
  for (const id of ["request_turnaround_time_average", "request_turnaround_time_median"] as const)
    paths.push(`${id}.n`, `${id}.value`);
  paths.push(
    "request_volume.value",
    "active_queue_workload.pending_without_stage.count",
    ...EFFICIENCY_METRICS.active_queue_workload.separateReports[0].population.conditions.map(
      (c) => `active_queue_workload.pending_without_stage.exclusions.${c.exclusion}`,
    ),
    "approval_rate.approved",
    "approval_rate.rejected",
    "approval_rate.value",
    "queue_throughput.overall",
    "queue_throughput.flags.unknown_queue",
  );
  for (const q of [...RECOGNIZED, "unknown"])
    paths.push(`active_queue_workload.queues.${q}`, `queue_throughput.queues.${q}`);
  return paths;
}

/**
 * Converts the F19.5.2 SQL result rows (metric_id, measure, expected, audit,
 * agrees, note) into the same leaf paths. The SQL knows nothing about
 * prototypes or load integrity, so only the paths it can report are produced.
 *
 * Strict: every result row must be parsed or be a known informational row,
 * every number must parse, and every required path must be present.
 * Otherwise it throws a SqlOutputError naming the row or the missing paths.
 * Lines outside the result section (session settings, schema checks,
 * distributions, \echo headings) are not result rows and are not read.
 */
export function flattenSql(tsv: string): Flat {
  const out: Flat = {};
  const set = (path: string, value: Leaf, line: number) => {
    if (path in out) throw new SqlOutputError(`line ${line}: duplicate value for ${path}.`);
    out[path] = value;
  };
  let summaryAll = false;
  let resultRows = 0;
  let approvalDenominator: number | undefined;

  tsv.split("\n").forEach((text, index) => {
    const line = index + 1;
    const cols = text.split("\t");
    if (!RESULT_METRICS.has(cols[0])) return;
    if (cols.length !== 6) {
      throw new SqlOutputError(
        `line ${line}: result row for "${cols[0]}" has ${cols.length} columns, expected 6 (metric_id, measure, expected, audit, agrees, note): ${text}`,
      );
    }
    resultRows += 1;
    const [metric, measure, expected] = cols;
    const unexpected = (why: string): never => {
      throw new SqlOutputError(`line ${line}: ${why}: ${metric} | ${measure} | ${expected}`);
    };
    const count = (textValue: string): number => {
      if (!/^\d+$/.test(textValue)) unexpected(`"${textValue}" is not a count`);
      return Number(textValue);
    };
    const statValue = (textValue: string): Leaf => {
      if (textValue === "no-data") return "no-data";
      if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(textValue))
        unexpected(`"${textValue}" is not a number or no-data`);
      return Number(textValue);
    };
    const absentOrCount = (textValue: string): Leaf =>
      textValue === "absent" ? null : count(textValue);

    if (measure.startsWith("SUMMARY")) {
      if (metric === "ALL") summaryAll = true;
      return;
    }

    const excl = /^\d+\. exclusion (\w+)$/.exec(measure);
    if (excl) {
      const targets = SQL_TARGETS[metric] ?? unexpected("exclusion row for an unknown population");
      for (const t of targets) set(`${t}.exclusions.${excl[1]}`, count(expected), line);
      return;
    }
    if (/^population in scope \/ included( \(.*\))?$/.test(measure)) {
      const targets = SQL_TARGETS[metric] ?? unexpected("population row for an unknown population");
      const pair =
        /^(\d+) \/ (\d+)$/.exec(expected) ?? unexpected('expected "<in scope> / <included>"');
      for (const t of targets) {
        set(`${t}.inScope`, Number(pair[1]), line);
        set(`${t}.included`, Number(pair[2]), line);
      }
      return;
    }

    const queue = /^queue (\w+) \((distinct requests|stage decisions)\)$/.exec(measure);
    const group = /^(\w+) \(n=(\d+)\)$/.exec(measure);
    const flag = /^flag (\w+) \(.*\)$/.exec(measure);
    const queueId = (id: string) =>
      RECOGNIZED.includes(id) ? id : unexpected(`"${id}" is not a recognized queue`);

    if (metric === "request_volume" && measure === "value (requests, created_at in period)")
      set("request_volume.value", count(expected), line);
    else if (metric === "active_queue_workload" && queue)
      set(`active_queue_workload.queues.${queueId(queue[1])}`, count(expected), line);
    else if (metric === "active_queue_workload" && measure === "unknown group (distinct requests)")
      set("active_queue_workload.queues.unknown", absentOrCount(expected), line);
    else if (metric === "active_queue_workload" && flag)
      set(`active_queue_workload.flags.${flag[1]}`, count(expected), line);
    else if (
      metric === "active_queue_workload" &&
      measure === "separate report pending_without_stage"
    )
      set("active_queue_workload.pending_without_stage.count", count(expected), line);
    else if (
      (metric === "stage_processing_time_average" || metric === "stage_processing_time_median") &&
      group
    ) {
      const path =
        group[1] === "overall" ? `${metric}.overall` : `${metric}.queues.${queueId(group[1])}`;
      set(`${path}.n`, Number(group[2]), line);
      set(`${path}.value`, statValue(expected), line);
    } else if (metric === "stage_processing_time_*" && measure === "unknown group") {
      // The database's queue allowlist makes an unknown queue impossible in stored rows.
      if (expected !== "absent")
        unexpected('the stage-time unknown group is only parsed as "absent"');
      for (const id of ["stage_processing_time_average", "stage_processing_time_median"]) {
        set(`${id}.queues.unknown.n`, null, line);
        set(`${id}.queues.unknown.value`, null, line);
      }
    } else if (metric === "stage_processing_time_*" && flag) {
      set(`stage_processing_time_average.flags.${flag[1]}`, count(expected), line);
      set(`stage_processing_time_median.flags.${flag[1]}`, count(expected), line);
    } else if (
      (metric === "request_turnaround_time_average" ||
        metric === "request_turnaround_time_median") &&
      /^value \(hours, n=\d+\)$/.test(measure)
    ) {
      set(`${metric}.n`, Number(/n=(\d+)/.exec(measure)?.[1]), line);
      set(`${metric}.value`, statValue(expected), line);
    } else if (metric === "approval_rate" && measure === "approved (A)")
      set("approval_rate.approved", count(expected), line);
    else if (metric === "approval_rate" && measure === "rejected (R)")
      set("approval_rate.rejected", count(expected), line);
    else if (metric === "approval_rate" && measure === "denominator (A + R)")
      approvalDenominator = count(expected);
    else if (metric === "approval_rate" && measure === "value A / (A + R)")
      set("approval_rate.value", statValue(expected), line);
    else if (metric === "queue_throughput" && queue)
      set(`queue_throughput.queues.${queueId(queue[1])}`, count(expected), line);
    else if (metric === "queue_throughput" && measure === "unknown group (stage decisions)")
      set("queue_throughput.queues.unknown", absentOrCount(expected), line);
    else if (
      metric === "queue_throughput" &&
      measure === "overall total (stage records, not requests)"
    )
      set("queue_throughput.overall", count(expected), line);
    else if (metric === "queue_throughput" && flag)
      set(`queue_throughput.flags.${flag[1]}`, count(expected), line);
    else {
      const info =
        INFORMATIONAL_ROWS.find((row) => row.metric === metric && row.measure.test(measure)) ??
        unexpected("unrecognized result row; update flattenSql or the F19.5.2 SQL");
      if (info.expected !== undefined && expected !== info.expected) {
        unexpected(`expected "${info.expected}" for this informational row`);
      }
    }
  });

  if (resultRows === 0) throw new SqlOutputError("no result rows found; is this F19.5.2 output?");
  if (!summaryAll) {
    throw new SqlOutputError(
      'the final "ALL | SUMMARY" row is missing; the output looks truncated.',
    );
  }
  const missing = requiredSqlPaths().filter((path) => !(path in out));
  if (missing.length > 0) {
    throw new SqlOutputError(`missing ${missing.length} required value(s): ${missing.join(", ")}`);
  }
  const approved = out["approval_rate.approved"] as number;
  const rejected = out["approval_rate.rejected"] as number;
  if (approvalDenominator !== approved + rejected) {
    throw new SqlOutputError(
      `approval rate denominator ${approvalDenominator} is not approved ${approved} + rejected ${rejected}.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type Comparison = {
  path: string;
  expected: Leaf | undefined;
  actual: Leaf | undefined;
  ok: boolean;
};

export const same = (expected: Leaf | undefined, actual: Leaf | undefined): boolean => {
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected));
  }
  return expected === actual;
};

/** Compares every expected path (and, when `exhaustive`, flags actual paths with no expectation). */
export function compare(expected: Flat, actual: Flat, exhaustive = true): Comparison[] {
  const paths = new Set(Object.keys(expected));
  if (exhaustive) for (const path of Object.keys(actual)) paths.add(path);
  return [...paths].sort().map((path) => ({
    path,
    expected: expected[path],
    actual: actual[path],
    ok: path in expected && path in actual && same(expected[path], actual[path]),
  }));
}

export type { PeriodBounds };
