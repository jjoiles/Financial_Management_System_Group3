import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static checks for the F19.5.4.1 security hardening migration. The database
 * behaviour is verified in a disposable database by
 * verification/f19_5_4_1_disposable_db.sh, which runs
 * verification/f19_5_4_1_security_hardening.sql.
 */

const MIGRATIONS_URL = new URL("../../../supabase/migrations/", import.meta.url);
const GUARD_FILE = "20261119072711_f19_2_decision_status_guard.sql";
const HARDENING_FILE = "20261119120100_f19_5_4_1_security_hardening.sql";

const migrationFiles = readdirSync(MIGRATIONS_URL)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const readMigration = (name: string) => readFileSync(new URL(name, MIGRATIONS_URL), "utf8");
const hardening = readMigration(HARDENING_FILE);

/** SQL with `--` comments removed, so comments cannot satisfy or break a check. */
const code = hardening
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const F19_TABLES = [
  "public.financial_requests",
  "public.approval_stage_tracking",
  "public.workflow_events",
  "public.request_workflow_amendments",
  "public.workflow_initialization_state",
];

/** Statements (split on `;` outside dollar quotes is not needed: the REVOKE/ALTER statements contain none). */
const statements = (pattern: RegExp) => [...code.matchAll(pattern)].map((match) => match[0]);

/** Names of BEFORE triggers on public.financial_requests created anywhere in the migration history. */
function beforeTriggersOnRequests(): string[] {
  const names = new Set<string>();
  for (const file of migrationFiles) {
    const sql = readMigration(file);
    for (const match of sql.matchAll(
      /CREATE\s+TRIGGER\s+(\w+)\s+BEFORE\s+[\w\s,]+?\s+ON\s+public\.financial_requests\b/gi,
    )) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe("migration placement", () => {
  it("is a new migration ordered after the F19.2 decision status guard", () => {
    expect(migrationFiles).toContain(HARDENING_FILE);
    expect(migrationFiles.indexOf(HARDENING_FILE)).toBeGreaterThan(
      migrationFiles.indexOf(GUARD_FILE),
    );
  });

  it("changes no data", () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+public\./i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\s+(TABLE\s+)?public\./i);
  });
});

describe("S1: created_at is assigned by the database and immutable", () => {
  it("assigns created_at first, before F4 derives metadata from it", () => {
    const names = beforeTriggersOnRequests();
    expect(names).toContain("f19_assign_request_created_at");
    expect(names[0]).toBe("f19_assign_request_created_at");
    expect(names.indexOf("f19_assign_request_created_at")).toBeLessThan(
      names.indexOf("f4_enforce_request_metadata"),
    );
    expect(code).toMatch(
      /CREATE TRIGGER f19_assign_request_created_at\s+BEFORE INSERT ON public\.financial_requests/,
    );
    expect(code).toMatch(/NEW\.created_at := pg_catalog\.now\(\);/);
  });

  it("checks the final row after every modifying trigger, on insert and update", () => {
    const names = beforeTriggersOnRequests();
    expect(names.slice(-2)).toEqual([
      "zz_f19_guard_request_created_at",
      "zz_f19_guard_request_status",
    ]);
    expect(code).toMatch(
      /CREATE TRIGGER zz_f19_guard_request_created_at\s+BEFORE INSERT OR UPDATE ON public\.financial_requests/,
    );
    expect(code).toMatch(/IF NEW\.created_at IS DISTINCT FROM OLD\.created_at THEN/);
    expect(code).toMatch(/IF NEW\.created_at IS DISTINCT FROM pg_catalog\.now\(\) THEN/);
  });

  it("has no bypass: no session setting, role check or SECURITY DEFINER", () => {
    expect(code).not.toMatch(/current_setting\(\s*'app\./i);
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(code).not.toMatch(/current_user|session_user|pg_has_role/i);
  });

  it("keeps the trigger functions away from API roles", () => {
    for (const fn of ["f19_assign_request_created_at", "f19_guard_request_created_at"]) {
      expect(code).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated;`,
      );
    }
  });

  it("leaves the S4 session-setting guard unchanged", () => {
    expect(code).not.toMatch(/f19_guard_request_workflow_fields/);
  });
});

describe("S2/S3: privileges", () => {
  const revokes = statements(/REVOKE[^;]*?ON TABLE[^;]*;/g);

  it("revokes only from anon and authenticated, never SELECT, never from service_role", () => {
    expect(revokes.length).toBeGreaterThan(0);
    for (const statement of revokes) {
      // The MAINTAIN revoke is inside EXECUTE '...', so it ends with a quote.
      expect(statement).toMatch(/FROM (anon, authenticated|anon|authenticated)'?;$/);
      expect(statement).not.toMatch(/\bSELECT\b|service_role|postgres/);
    }
  });

  it("names exactly the five F19 tables, with no schema-wide statement", () => {
    const named = new Set(revokes.flatMap((s) => s.match(/public\.\w+/g) ?? []));
    expect([...named].sort()).toEqual([...F19_TABLES].sort());
    expect(code).not.toMatch(/ALL TABLES IN SCHEMA/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
  });

  it("removes TRUNCATE, TRIGGER, REFERENCES and MAINTAIN from both API roles on every F19 table", () => {
    const s2 = revokes.find((s) => s.startsWith("REVOKE TRUNCATE, TRIGGER, REFERENCES"));
    expect(s2).toBeDefined();
    for (const table of F19_TABLES) expect(s2).toContain(table);
    expect(s2).toMatch(/FROM anon, authenticated;$/);
    const maintain = revokes.find((s) => s.startsWith("REVOKE MAINTAIN"));
    expect(maintain).toBeDefined();
    for (const table of F19_TABLES) expect(maintain).toContain(table);
    expect(code).toMatch(/current_setting\('server_version_num'\)::INTEGER >= 170000/);
  });

  it("removes direct writes from anon, and from authenticated only where no policy exists", () => {
    const anonWrites = revokes.find((s) =>
      /^REVOKE INSERT, UPDATE, DELETE[\s\S]*FROM anon;$/.test(s),
    );
    expect(anonWrites).toBeDefined();
    for (const table of F19_TABLES) expect(anonWrites).toContain(table);

    const authenticatedDml = revokes.filter(
      (s) => /FROM authenticated;$/.test(s) && /INSERT|UPDATE|DELETE/.test(s),
    );
    expect(authenticatedDml.sort()).toEqual(
      [
        "REVOKE DELETE ON TABLE public.financial_requests FROM authenticated;",
        "REVOKE UPDATE, DELETE ON TABLE public.workflow_events FROM authenticated;",
      ].sort(),
    );
  });

  it("corrects default privileges only for role postgres in schema public", () => {
    const defaults = statements(/ALTER DEFAULT PRIVILEGES[^;']*/g);
    expect(defaults.length).toBe(3);
    for (const statement of defaults) {
      expect(statement).toMatch(/^ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\s/);
      expect(statement).toMatch(/ON TABLES FROM (anon, authenticated|anon)$/);
      expect(statement).not.toMatch(/\bSELECT\b/);
    }
  });
});
