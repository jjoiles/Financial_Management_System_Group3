import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static checks for the F19.5.4.2 workflow event provenance migration. The
 * database behaviour is verified in a disposable database by
 * verification/f19_5_4_1_disposable_db.sh, which runs
 * verification/f19_5_4_2_event_provenance.sql.
 */

const MIGRATIONS_URL = new URL("../../../supabase/migrations/", import.meta.url);
const HARDENING_FILE = "20261119120100_f19_5_4_1_security_hardening.sql";
const PROVENANCE_FILE = "20261119130000_f19_5_4_2_event_provenance.sql";

const migrationFiles = readdirSync(MIGRATIONS_URL)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const readMigration = (name: string) => readFileSync(new URL(name, MIGRATIONS_URL), "utf8");
const withoutComments = (sql: string) =>
  sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
const provenance = readMigration(PROVENANCE_FILE);
const code = withoutComments(provenance);

const EVENT_TYPE = /^[a-z]+(?:_[a-z]+)+$/;

/** Splits a parenthesised SQL list at top-level commas, respecting nesting and quotes. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of list) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === "(") depth += 1;
    if (!quoted && char === ")") depth -= 1;
    if (!quoted && depth === 0 && char === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** The text inside the parentheses that open at `start`. */
function parenthesised(sql: string, start: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start + 1, i);
    }
  }
  throw new Error("unbalanced parentheses");
}

/**
 * Every event_type a database function writes, across the whole migration
 * history: the event_type value of each INSERT INTO public.workflow_events,
 * resolved through event_type_value assignments where a variable is used.
 */
function databaseEventTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of migrationFiles) {
    const sql = withoutComments(readMigration(file));
    const assigned = [...sql.matchAll(/event_type_value\s*:=\s*'([a-z_]+)'/g)].map((m) => m[1]);
    for (const match of sql.matchAll(/INSERT INTO public\.workflow_events\s*\(/g)) {
      const columnsStart = (match.index ?? 0) + match[0].length - 1;
      const columns = splitTopLevel(parenthesised(sql, columnsStart));
      const valuesAt = sql.indexOf("VALUES", columnsStart);
      const selectAt = sql.indexOf("SELECT", columnsStart);
      expect(valuesAt, `${file}: workflow event insert uses VALUES`).toBeGreaterThan(0);
      if (selectAt > 0 && selectAt < valuesAt)
        throw new Error(`${file}: INSERT ... SELECT is not parsed`);
      const values = splitTopLevel(parenthesised(sql, sql.indexOf("(", valuesAt)));
      const expression = values[columns.indexOf("event_type")];
      expect(expression, `${file}: event_type value`).toBeDefined();
      const literals = [...expression.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const found = expression.trim() === "event_type_value" ? assigned : literals;
      for (const type of found.filter((value) => EVENT_TYPE.test(value))) types.add(type);
    }
  }
  return types;
}

const reservedInMigration = (): string[] => {
  const list = code.match(/reserved_event_types CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
  expect(list).not.toBeNull();
  return [...(list?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe("migration placement", () => {
  it("is a new migration ordered after the F19.5.4.1 hardening migration", () => {
    expect(migrationFiles).toContain(PROVENANCE_FILE);
    expect(migrationFiles.indexOf(PROVENANCE_FILE)).toBeGreaterThan(
      migrationFiles.indexOf(HARDENING_FILE),
    );
  });

  it("changes no data and no existing policy", () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
  });
});

describe("workflow event provenance", () => {
  it("reserves exactly the event types that database functions write", () => {
    const reserved = reservedInMigration();
    expect(new Set(reserved).size).toBe(reserved.length);
    expect([...reserved].sort()).toEqual([...databaseEventTypes()].sort());
  });

  it("finds every known database event path", () => {
    expect([...databaseEventTypes()].sort()).toEqual(
      [
        "approval_approved",
        "approval_rejected",
        "attachment_added",
        "attachment_removed",
        "record_linked",
        "request_amended",
        "request_created",
        "request_updated",
        "routing_changed",
        "status_changed",
        "workflow_failed",
        "workflow_initialized",
      ].sort(),
    );
  });

  it("trusts only the table owner, read from pg_class, never a session setting", () => {
    expect(code).toMatch(
      /SELECT pg_catalog\.pg_get_userbyid\(c\.relowner\) = current_user\s+INTO trusted\s+FROM pg_catalog\.pg_class c\s+WHERE c\.oid = TG_RELID;/,
    );
    expect(code).not.toMatch(/current_setting\(\s*'app\./i);
    expect(code).not.toMatch(/SECURITY DEFINER/i);
  });

  it("derives client actor, time and source from the database", () => {
    expect(code).toMatch(/NEW\.actor_user_id := caller;/);
    expect(code).toMatch(/caller := auth\.uid\(\);/);
    expect(code).toMatch(/NEW\.created_at := pg_catalog\.now\(\);/);
    expect(code).toMatch(
      /NEW\.metadata := NEW\.metadata \|\| pg_catalog\.jsonb_build_object\('source', 'client'\);/,
    );
    expect(code).toMatch(
      /IF NEW\.metadata \? 'source' AND \(NEW\.metadata ->> 'source'\) IS DISTINCT FROM 'client' THEN/,
    );
  });

  it("guards inserts on workflow_events and keeps the function from API roles", () => {
    expect(code).toMatch(
      /CREATE TRIGGER f19_guard_workflow_event_provenance\s+BEFORE INSERT ON public\.workflow_events/,
    );
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION public.f19_guard_workflow_event_provenance() FROM PUBLIC, anon, authenticated;",
    );
  });

  it("leaves the S4 session-setting guard unchanged", () => {
    expect(code).not.toMatch(/f19_guard_request_workflow_fields/);
  });
});

describe("default DELETE privilege", () => {
  it("removes only DELETE, only from authenticated, only for postgres in public", () => {
    const defaults = [...code.matchAll(/ALTER DEFAULT PRIVILEGES[^;]*;/g)].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    expect(defaults).toEqual([
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE DELETE ON TABLES FROM authenticated;",
    ]);
    expect(code).not.toMatch(/\bGRANT\b|REVOKE[^;]*ON TABLE\b/i);
  });
});
