import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// F7.4: Verify Workflow Initialization (#268). Runs the real workflow logic
// against an in-memory stand-in for Supabase, with fetch stubbed.

import { runInitializeWorkflow } from "./run-initialize-workflow";

type Row = Record<string, unknown>;

const REQUEST_ID = "9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const FLOW_URL = "https://prod-00.westus.logic.azure.com/workflows/test/triggers/manual/run";

// Minimal Supabase query builder: select/eq/limit/maybeSingle, update, insert, rpc.
function createFakeDb(request: Row) {
  const tables: Record<string, Row[]> = {
    financial_requests: [request],
    workflow_events: [],
  };
  const rpcCalls: string[] = [];

  const query = (table: string) => {
    const filters: [string, unknown][] = [];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    const matching = () =>
      tables[table].filter((row) => filters.every(([key, value]) => row[key] === value));
    const run = () => {
      if (op === "update") {
        matching().forEach((row) => Object.assign(row, patch));
        return { data: null, error: null };
      }
      return { data: matching(), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      },
      limit: () => builder,
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      update: (values: Row) => {
        op = "update";
        patch = values;
        return builder;
      },
      insert: async (values: Row) => {
        op = "insert";
        tables[table].push({ id: crypto.randomUUID(), ...values });
        return { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => resolve(run()),
    };
    return builder;
  };

  const db = {
    from: query,
    rpc: async (name: string) => {
      rpcCalls.push(name);
      return { data: "stage-id", error: null };
    },
  };
  return { db, tables, rpcCalls };
}

const baseRequest = (): Row => ({
  id: REQUEST_ID,
  request_number: "FR-2026-ABC123",
  user_id: USER_ID,
  title: "Lab equipment",
  requester_email: "faculty@howard.edu",
  department: "Computer Science",
  funding_source: "department",
  amount: "5000.00",
  needed_by: "2026-12-31",
  priority: "medium",
  grant_number: null,
  principal_investigator: null,
  university_program: null,
  status: "submitted",
  created_at: "2026-11-23T15:00:00Z",
  routed_to: null,
  metadata: {},
  workflow_triggered_at: null,
});

const call = (db: unknown) =>
  runInitializeWorkflow(db as Parameters<typeof runInitializeWorkflow>[0], USER_ID, REQUEST_ID);

describe("F7.4 workflow initialization", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("F7.4.1 (#308): simulated mode with no flow URL", () => {
    it("records a simulated workflow_initialized event and sets workflow_triggered_at", async () => {
      vi.stubEnv("POWER_AUTOMATE_FLOW_URL", "");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { db, tables, rpcCalls } = createFakeDb(baseRequest());

      const result = await call(db);

      expect(result).toMatchObject({
        mode: "simulated",
        alreadyInitialized: false,
        routedTo: "Department Budget Reviewer",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(tables.workflow_events).toHaveLength(1);
      expect(tables.workflow_events[0]).toMatchObject({
        event_type: "workflow_initialized",
        metadata: {
          mode: "simulated",
          approvalChain: ["Department Budget Reviewer", "Dean's Office"],
        },
      });
      const request = tables.financial_requests[0];
      expect(request.workflow_triggered_at).toEqual(expect.any(String));
      expect(request.routed_to).toBe("Department Budget Reviewer");
      expect((request.metadata as Row).routing).toBeDefined();
      expect(rpcCalls).toEqual(["f16_start_initial_approval_stage"]);
    });
  });

  describe("F7.4.2 (#309): flow run accepted (mocked HTTP, not a live flow)", () => {
    it("posts the signed payload and stores the run id", async () => {
      vi.stubEnv("POWER_AUTOMATE_FLOW_URL", FLOW_URL);
      vi.stubEnv("POWER_AUTOMATE_SHARED_SECRET", "test-secret");
      const fetchSpy = vi.fn(
        async () =>
          new Response(null, { status: 202, headers: { "x-ms-workflow-run-id": "run-123" } }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const { db, tables } = createFakeDb(baseRequest());

      const result = await call(db);

      expect(result.mode).toBe("power_automate");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(url).toBe(FLOW_URL);
      expect(headers["x-finreq-idempotency-key"]).toBe(REQUEST_ID);
      expect(headers["x-finreq-signature"]).toMatch(/^[0-9a-f]{64}$/);
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        event: "request.submitted",
        requestId: REQUEST_ID,
        amount: 5000,
      });
      expect(tables.workflow_events[0]).toMatchObject({
        event_type: "workflow_initialized",
        metadata: { mode: "power_automate", runId: "run-123", httpStatus: 202 },
      });
    });
  });

  describe("F7.4.3 (#310): flow failure and idempotent retries", () => {
    it("a 400 from the flow is not retried, logs workflow_failed, and leaves workflow_triggered_at null", async () => {
      vi.stubEnv("POWER_AUTOMATE_FLOW_URL", FLOW_URL);
      const fetchSpy = vi.fn(async () => new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetchSpy);
      const { db, tables, rpcCalls } = createFakeDb(baseRequest());

      const result = await call(db);

      expect(result.mode).toBe("failed");
      expect(result.message).toMatch(/did not accept it: Flow returned HTTP 400/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tables.workflow_events).toHaveLength(1);
      expect(tables.workflow_events[0]).toMatchObject({
        event_type: "workflow_failed",
        metadata: { mode: "failed", httpStatus: 400 },
      });
      expect(tables.financial_requests[0].workflow_triggered_at).toBeNull();
      expect(rpcCalls).toEqual([]);
    });

    it("a second call for the same request writes no new event and does not call the flow again", async () => {
      vi.stubEnv("POWER_AUTOMATE_FLOW_URL", FLOW_URL);
      const fetchSpy = vi.fn(async () => new Response(null, { status: 202 }));
      vi.stubGlobal("fetch", fetchSpy);
      const { db, tables } = createFakeDb(baseRequest());

      const first = await call(db);
      const second = await call(db);

      expect(first).toMatchObject({ mode: "power_automate", alreadyInitialized: false });
      expect(second).toMatchObject({
        mode: "power_automate",
        alreadyInitialized: true,
        attempts: 0,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(
        tables.workflow_events.filter((e) => e.event_type === "workflow_initialized"),
      ).toHaveLength(1);
    });
  });
});
