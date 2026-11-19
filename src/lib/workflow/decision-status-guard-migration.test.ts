import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static checks for the F19.2 decision status guard migration. The database
 * behaviour itself is verified by verification/f19_2_status_guard.sql and
 * verification/f19_2_status_guard_concurrency.sh against the local stack.
 */

const MIGRATIONS_URL = new URL("../../../supabase/migrations/", import.meta.url);
const F19_2_FILE = "20261119030549_f19_2_workflow_integrity.sql";
const GUARD_FILE = "20261119072711_f19_2_decision_status_guard.sql";

const migrationFiles = readdirSync(MIGRATIONS_URL)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const readMigration = (name: string) => readFileSync(new URL(name, MIGRATIONS_URL), "utf8");

const f19_2 = readMigration(F19_2_FILE);
const guard = readMigration(GUARD_FILE);

const ELIGIBILITY_CHECK = [
  "\tIF request_row.status NOT IN (",
  "\t\t'submitted'::public.request_status,",
  "\t\t'under_review'::public.request_status",
  "\t) THEN",
  "\t\tRAISE EXCEPTION",
  "\t\t\t'Only requests awaiting a decision can be amended. Current status: %.',",
  "\t\t\trequest_row.status;",
  "\tEND IF;",
  "",
  "",
].join("\n");

/** The CREATE OR REPLACE FUNCTION statement for `name`, through its closing `$$;`. */
function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, start + 1)).toBe(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

/** Statement text from `REVOKE|GRANT ... ON FUNCTION public.name(` through the next `;`. */
function privilegeStatements(sql: string, name: string): string[] {
  const pattern = new RegExp(`(?:REVOKE|GRANT)[^;]*?ON FUNCTION public\\.${name}\\([^;]*;`, "g");
  return [...sql.matchAll(pattern)].map((match) => match[0]);
}

const amendBefore = functionDefinition(f19_2, "f19_amend_request_workflow");
const amendAfter = functionDefinition(guard, "f19_amend_request_workflow");
const guardFunction = functionDefinition(guard, "f19_guard_request_status");

describe("migration placement", () => {
  it("is a new migration ordered after F19.2", () => {
    expect(migrationFiles).toContain(F19_2_FILE);
    expect(migrationFiles).toContain(GUARD_FILE);
    expect(migrationFiles.indexOf(GUARD_FILE)).toBeGreaterThan(migrationFiles.indexOf(F19_2_FILE));
  });

  it("leaves the F19.2 amendment function without the eligibility check", () => {
    expect(f19_2).not.toContain("Only requests awaiting a decision can be amended");
    expect(f19_2).not.toContain("f19_guard_request_status");
  });
});

describe("Layer 1: amendment eligibility", () => {
  it("is the F19.2 function body plus exactly the eligibility check", () => {
    expect(amendAfter.split(ELIGIBILITY_CHECK)).toHaveLength(2);
    expect(amendAfter.replace(ELIGIBILITY_CHECK, "")).toBe(amendBefore);
  });

  it("checks status after the row lock and authorization and before any validation or write", () => {
    const order = [
      "FOR UPDATE;",
      "RAISE EXCEPTION 'Not authorized to amend this request.';",
      "Only requests awaiting a decision can be amended",
      "f19_request_has_initialized_workflow(_request_id",
      "next_revision := request_row.workflow_revision + 1;",
      "status = 'cancelled',",
      "status = 'submitted',",
      "public.f16_start_initial_approval_stage(_request_id)",
      "status = 'under_review',",
    ].map((marker) => {
      const index = amendAfter.indexOf(marker);
      expect(index, marker).toBeGreaterThanOrEqual(0);
      return index;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps SECURITY DEFINER and the F19.2 search_path", () => {
    expect(amendAfter).toContain("SECURITY DEFINER\nSET search_path = public, pg_temp\n");
  });

  it("restates the F19.2 grants exactly", () => {
    const before = privilegeStatements(f19_2, "f19_amend_request_workflow");
    expect(before).toHaveLength(2);
    expect(privilegeStatements(guard, "f19_amend_request_workflow")).toEqual(before);
    expect(before[0]).toMatch(/FROM PUBLIC, anon;$/);
    expect(before[1]).toMatch(/^GRANT EXECUTE[\s\S]*TO authenticated;$/);
  });
});

describe("Layer 2: status guard", () => {
  it("runs as the caller, never as SECURITY DEFINER", () => {
    expect(guardFunction).toContain("SECURITY INVOKER");
    expect(guardFunction).not.toContain("SECURITY DEFINER");
  });

  it("anchors trust on the table owner, not on a client-settable setting", () => {
    expect(guardFunction).toContain("pg_catalog.pg_get_userbyid(c.relowner) = current_user");
    expect(guardFunction).toContain("WHERE c.oid = TG_RELID");
    expect(guardFunction).not.toMatch(/current_setting|set_config|session_user/);
    expect(guardFunction).not.toMatch(/'postgres'|service_role/);
  });

  it("treats approved, rejected and completed as final for every caller", () => {
    const finalCheck = guardFunction.indexOf("IF OLD.status IN (");
    const trustCheck = guardFunction.indexOf("IF NOT trusted THEN");
    expect(finalCheck).toBeGreaterThan(0);
    expect(finalCheck).toBeLessThan(trustCheck);
    const finalList = guardFunction.slice(finalCheck, guardFunction.indexOf(") THEN", finalCheck));
    for (const status of ["approved", "rejected", "completed"]) {
      expect(finalList).toContain(`'${status}'::public.request_status`);
    }
  });

  it("allows only the workflow transitions, none of them into completed", () => {
    const transitions = guardFunction.slice(
      guardFunction.indexOf("-- R3"),
      guardFunction.indexOf("-- R4"),
    );
    expect(transitions).not.toContain("completed");
    expect(transitions).toContain("OLD.status = 'submitted'::public.request_status");
    expect(transitions).toContain("OLD.status = 'under_review'::public.request_status");
  });

  it("requires a completed final stage in the current revision for a decision", () => {
    const r4 = guardFunction.slice(guardFunction.indexOf("-- R4"));
    expect(r4).toContain("ast.workflow_revision = NEW.workflow_revision");
    expect(r4).toContain("ORDER BY ast.stage_order DESC");
    expect(r4).toContain("AND ast.status = 'active'");
    expect(r4).toContain("IS DISTINCT FROM 'completed'");
  });

  it("revokes EXECUTE from every API role", () => {
    expect(guard).toContain(
      "REVOKE ALL ON FUNCTION public.f19_guard_request_status()\nFROM PUBLIC, anon, authenticated, service_role;",
    );
  });

  it("fires on every insert and update, after every other BEFORE trigger on the table", () => {
    expect(guard).toContain(
      "CREATE TRIGGER zz_f19_guard_request_status\nBEFORE INSERT OR UPDATE ON public.financial_requests\nFOR EACH ROW\nEXECUTE FUNCTION public.f19_guard_request_status();",
    );
    const triggerNames = migrationFiles.flatMap((name) =>
      [
        ...readMigration(name).matchAll(
          /CREATE TRIGGER\s+(\w+)\s+BEFORE\b[^;]*?\bON\s+public\.financial_requests\b/gi,
        ),
      ].map((match) => match[1]),
    );
    expect(triggerNames).toContain("zz_f19_guard_request_status");
    const others = triggerNames.filter((name) => name !== "zz_f19_guard_request_status");
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) expect(name < "zz_f19_guard_request_status").toBe(true);
  });

  it("is not undermined by a trigger that assigns NEW.status", () => {
    for (const name of migrationFiles) {
      expect(readMigration(name), name).not.toMatch(/NEW\.status\s*:=/i);
    }
  });
});
