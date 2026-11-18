import { z } from "zod";
import { deepFreeze } from "@/lib/deep-freeze";
import { HOWARD_ACADEMIC_CALENDAR } from "@/lib/howard-academic-calendar";
import {
  academicCalendarSchema,
  getAcademicCalendarCoverage,
  isValidLocalDate,
  type AcademicCalendar,
} from "@/lib/reporting-periods";

/**
 * F18.2: Reporting period configuration.
 *
 * A static, versioned, deeply frozen configuration that is validated when this
 * module is imported, so invalid calendar data fails immediately (and in CI)
 * instead of on the first lookup. Pure and browser-safe: no I/O.
 *
 * Dependency direction: this module imports reporting-periods.ts and
 * howard-academic-calendar.ts. Neither may import this module, and
 * howard-academic-calendar.ts must stay data-only.
 *
 * What is configured here
 * - The academic calendar (the same deeply frozen HOWARD_ACADEMIC_CALENDAR
 *   object that reporting-periods.ts uses by default, so both share one cache).
 *
 * What is deliberately not configured here
 * - Fiscal periods: owned by deriveFiscalPeriod() in request-utils.ts and the
 *   f4_enforce_request_metadata() SQL trigger. They are unchanged.
 * - Calendar months: fixed UTC months; nothing to configure.
 * - Time zones: F18.3.
 *
 * See docs/F18_Reporting_Period_Configuration.md for the maintenance process.
 */

/**
 * Configuration version, in the RULES_VERSION format YYYY-MM-DD.N.
 * Bump it manually whenever the calendar data or this configuration changes
 * (see docs/F18_Reporting_Period_Configuration.md). No automated check
 * enforces the bump; reviewers must confirm it.
 */
export const REPORTING_PERIOD_CONFIG_VERSION = "2026-11-18.1";

export interface ReportingPeriodConfig {
  readonly version: string;
  readonly academicCalendar: AcademicCalendar;
}

/** YYYY-MM-DD.N: a real calendar date, then a sequence number of 1 or more without leading zeros. */
const VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})\.([1-9]\d*)$/;

function isValidVersion(version: string): boolean {
  const match = VERSION_PATTERN.exec(version);
  return match !== null && isValidLocalDate(match[1]);
}

export const reportingPeriodConfigSchema = z
  .object({
    version: z.string().refine(isValidVersion, {
      message: "must match YYYY-MM-DD.N with a real date and N of 1 or more without leading zeros",
    }),
    academicCalendar: academicCalendarSchema,
  })
  .strict();

export type ReportingPeriodConfigValidationResult =
  | { ok: true; data: ReportingPeriodConfig }
  | { ok: false; errors: string[] };

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * Finds structure that Zod does not check but deepFreeze() would act on:
 * circular references, array properties other than indexes (Zod reads only
 * the indexes), and symbol-keyed, non-enumerable or accessor properties (Zod
 * ignores the first two, and an accessor could return different values after
 * validation). Shared references that are not circular are allowed.
 */
function findStructureErrors(candidate: unknown): string[] {
  const errors: string[] = [];
  const ancestors = new WeakSet<object>();
  const at = (path: readonly (string | number)[]) => path.join(".") || "config";

  const visit = (node: unknown, path: readonly (string | number)[]): void => {
    if (node === null || typeof node !== "object") return;
    if (ancestors.has(node)) {
      errors.push(`${at(path)}: circular reference`);
      return;
    }
    ancestors.add(node);
    const isArray = Array.isArray(node);
    const length = isArray ? node.length : 0;
    for (const key of Reflect.ownKeys(node)) {
      if (isArray && key === "length") continue;
      if (typeof key === "symbol") {
        errors.push(`${at(path)}: symbol-keyed properties are not allowed`);
        continue;
      }
      const isIndex = isArray && ARRAY_INDEX_PATTERN.test(key) && Number(key) < length;
      const keyPath = [...path, isIndex ? Number(key) : key];
      if (isArray && !isIndex) {
        errors.push(`${at(keyPath)}: unexpected array property`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !("value" in descriptor)) {
        errors.push(`${at(keyPath)}: accessor properties are not allowed`);
        continue;
      }
      if (!descriptor.enumerable) {
        errors.push(`${at(keyPath)}: non-enumerable properties are not allowed`);
        continue;
      }
      visit(descriptor.value, keyPath);
    }
    ancestors.delete(node);
  };

  visit(candidate, []);
  return errors;
}

/**
 * Checks a configuration candidate. Never throws, and never freezes or
 * changes the candidate.
 *
 * Checks run in order, and each runs only if the previous one passed:
 * 1. Structure: plain acyclic data with no extra array properties (see
 *    findStructureErrors). Zod does not guarantee this.
 * 2. The Zod schema: version format, no unknown keys, every F18.1 academic
 *    calendar rule.
 * 3. Coverage: academic years must be consecutive.
 * Errors use the same "path: message" format as validateAcademicCalendar().
 *
 * On success `data` is the candidate object itself, not a copy, so callers
 * keep its identity (and its period cache in reporting-periods.ts).
 */
export function validateReportingPeriodConfig(
  candidate: unknown,
): ReportingPeriodConfigValidationResult {
  const structureErrors = findStructureErrors(candidate);
  if (structureErrors.length > 0) return { ok: false, errors: structureErrors };

  const parsed = reportingPeriodConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
      ),
    };
  }

  const config = candidate as ReportingPeriodConfig;
  try {
    getAcademicCalendarCoverage(config.academicCalendar);
  } catch (error) {
    return {
      ok: false,
      errors: [`academicCalendar: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return { ok: true, data: config };
}

/**
 * Validates a configuration, then deep-freezes it in place and returns the
 * same object. Invalid input is never frozen.
 *
 * @throws Error listing every validation message.
 */
export function defineReportingPeriodConfig(candidate: unknown): ReportingPeriodConfig {
  const validation = validateReportingPeriodConfig(candidate);
  if (!validation.ok) {
    throw new Error(`Invalid reporting period configuration: ${validation.errors.join("; ")}`);
  }
  // Validation has already rejected cycles and properties Zod does not check,
  // so freezing covers exactly the validated data.
  return deepFreeze(validation.data);
}

/** The shipped configuration. Validated when this module is imported. */
export const REPORTING_PERIOD_CONFIG: ReportingPeriodConfig = defineReportingPeriodConfig({
  version: REPORTING_PERIOD_CONFIG_VERSION,
  academicCalendar: HOWARD_ACADEMIC_CALENDAR,
});
