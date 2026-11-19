import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeWorkflowCore } from "./initialize-workflow";

type RpcCall = { fn: string; args: Record<string, unknown> };

function buildDb(options?: {
  requestRow?: Record<string, unknown>;
  routingUpdateError?: string;
  claim?: Record<string, unknown>;
  claimError?: string;
  complete?: Record<string, unknown>;
  completeError?: string;
}) {
  const calls: RpcCall[] = [];
  const requestRow =
    options?.requestRow ??
    ({
      id: "11111111-1111-4111-8111-111111111111",
      request_number: "FR-2026-ABC123",
      user_id: "22222222-2222-4222-8222-222222222222",
      title: "Lab equipment",
      requester_email: "faculty@howard.edu",
      department: "Chemistry",
      funding_source: "department",
      amount: 1200,
      needed_by: "2030-01-15",
      priority: "medium",
      grant_number: null,
      principal_investigator: null,
      university_program: null,
      status: "submitted",
      created_at: "2026-11-01T00:00:00.000Z",
      routed_to: "Department Budget Reviewer",
      workflow_revision: 1,
      metadata: {
        routing: {
          primaryQueue: "department_budget",
          primaryLabel: "Department Budget Reviewer",
          approvalChain: [
            {
              step: 1,
              queue: "department_budget",
              label: "Department Budget Reviewer",
            },
          ],
        },
      },
    } satisfies Record<string, unknown>);

  const db = {
    from: (table: string) => {
      if (table !== "financial_requests") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: requestRow, error: null }),
          }),
        }),
        update: () => ({
          eq: async () => ({
            error: options?.routingUpdateError ? { message: options.routingUpdateError } : null,
          }),
        }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "f19_claim_workflow_initialization") {
        return {
          data:
            options?.claim ??
            ({
              alreadyInitialized: false,
              claimGranted: true,
              claimToken: "33333333-3333-4333-8333-333333333333",
              requestRevision: 1,
            } satisfies Record<string, unknown>),
          error: options?.claimError ? { message: options.claimError } : null,
        };
      }
      if (fn === "f19_complete_workflow_initialization") {
        return {
          data:
            options?.complete ??
            ({
              mode: "simulated",
              requestRevision: 1,
              initialStageId: "44444444-4444-4444-8444-444444444444",
              failed: false,
            } satisfies Record<string, unknown>),
          error: options?.completeError ? { message: options.completeError } : null,
        };
      }
      throw new Error(`Unexpected RPC: ${fn}`);
    },
  };

  return { db, calls };
}

describe("initializeWorkflowCore", () => {
  it("returns already initialized when the claim reports completion", async () => {
    const { db } = buildDb({
      claim: {
        alreadyInitialized: true,
        claimGranted: false,
        completionMode: "simulated",
      },
    });

    const result = await initializeWorkflowCore({
      db,
      requestId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      appBaseUrl: "https://finreq.local",
    });

    expect(result.alreadyInitialized).toBe(true);
    expect(result.mode).toBe("simulated");
  });

  it("returns ambiguous when an active claim already exists", async () => {
    const { db } = buildDb({
      claim: {
        alreadyInitialized: false,
        claimGranted: false,
        claimToken: null,
        requestRevision: 1,
      },
    });

    const result = await initializeWorkflowCore({
      db,
      requestId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      appBaseUrl: "https://finreq.local",
    });

    expect(result.mode).toBe("ambiguous");
    expect(result.message).toMatch(/already in progress/i);
  });

  it("throws when completion fails after a successful claim", async () => {
    const { db } = buildDb({ completeError: "completion failed" });

    await expect(
      initializeWorkflowCore({
        db,
        requestId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        appBaseUrl: "https://finreq.local",
      }),
    ).rejects.toThrow("Could not complete workflow initialization");
  });

  it("uses revision-scoped idempotency key in completion metadata", async () => {
    const { db, calls } = buildDb({
      claim: {
        alreadyInitialized: false,
        claimGranted: true,
        claimToken: "33333333-3333-4333-8333-333333333333",
        requestRevision: 7,
      },
    });

    await initializeWorkflowCore({
      db,
      requestId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      appBaseUrl: "https://finreq.local",
    });

    const completeCall = calls.find((c) => c.fn === "f19_complete_workflow_initialization");
    expect(completeCall).toBeDefined();
    expect((completeCall?.args._event_metadata as { idempotencyKey: string }).idempotencyKey).toBe(
      "11111111-1111-4111-8111-111111111111:7",
    );
  });

  describe("Power Automate outcome -> initialization completion mode", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    type FetchStep = { reject: Error } | { status: number };

    // Drives initializeWorkflowCore through the real postToFlow with the
    // default retry policy, using a stubbed global fetch and fake timers.
    async function runWithFlow(steps: FetchStep[]) {
      vi.useFakeTimers();
      const fetchMock = vi.fn();
      for (const step of steps) {
        if ("reject" in step) fetchMock.mockRejectedValueOnce(step.reject);
        else fetchMock.mockResolvedValueOnce(new Response("x", { status: step.status }));
      }
      vi.stubGlobal("fetch", fetchMock);

      const { db, calls } = buildDb();
      const pending = initializeWorkflowCore({
        db,
        requestId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        flowUrl: "https://example.com/flow",
        appBaseUrl: "https://finreq.local",
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      const completeCall = calls.find((c) => c.fn === "f19_complete_workflow_initialization");
      return { result, completeCall, fetchMock };
    }

    const timeout = () => ({ reject: new DOMException("timed out", "AbortError") });

    it("timeout then HTTP 400 completes as ambiguous, not failed", async () => {
      const { result, completeCall, fetchMock } = await runWithFlow([timeout(), { status: 400 }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.mode).toBe("ambiguous");
      expect(completeCall?.args._mode).toBe("ambiguous_timeout");
      expect((completeCall?.args._event_metadata as { uncertain?: boolean }).uncertain).toBe(true);
    });

    it("HTTP 503 then HTTP 400 completes as ambiguous, not failed", async () => {
      const { result, completeCall } = await runWithFlow([{ status: 503 }, { status: 400 }]);
      expect(result.mode).toBe("ambiguous");
      expect(completeCall?.args._mode).toBe("ambiguous_timeout");
    });

    it("HTTP 400 on the first attempt completes as a definite failure", async () => {
      const { result, completeCall, fetchMock } = await runWithFlow([{ status: 400 }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.mode).toBe("failed");
      expect(completeCall?.args._mode).toBe("failed");
      expect(
        (completeCall?.args._event_metadata as { uncertain?: boolean }).uncertain,
      ).toBeUndefined();
    });

    it("timeout then successful retry completes as power_automate", async () => {
      const { result, completeCall } = await runWithFlow([timeout(), { status: 202 }]);
      expect(result.mode).toBe("power_automate");
      expect(result.attempts).toBe(2);
      expect(completeCall?.args._mode).toBe("power_automate");
    });

    it("exhausted transport/5xx retries complete as ambiguous", async () => {
      const { result, completeCall, fetchMock } = await runWithFlow([
        timeout(),
        { status: 503 },
        { reject: new TypeError("fetch failed") },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.mode).toBe("ambiguous");
      expect(result.attempts).toBe(3);
      expect(completeCall?.args._mode).toBe("ambiguous_timeout");
    });
  });

  it("throws when routing repair fails", async () => {
    const { db } = buildDb({
      requestRow: {
        id: "11111111-1111-4111-8111-111111111111",
        request_number: "FR-2026-ABC123",
        user_id: "22222222-2222-4222-8222-222222222222",
        title: "Lab equipment",
        requester_email: "faculty@howard.edu",
        department: "Chemistry",
        funding_source: "department",
        amount: 1200,
        needed_by: "2030-01-15",
        priority: "medium",
        grant_number: null,
        principal_investigator: null,
        university_program: null,
        status: "submitted",
        created_at: "2026-11-01T00:00:00.000Z",
        routed_to: "Wrong Label",
        workflow_revision: 1,
        metadata: {},
      },
      routingUpdateError: "update blocked",
    });

    await expect(
      initializeWorkflowCore({
        db,
        requestId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        appBaseUrl: "https://finreq.local",
      }),
    ).rejects.toThrow("Could not save request routing");
  });
});
