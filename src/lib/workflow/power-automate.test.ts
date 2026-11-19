import { describe, expect, it, vi } from "vitest";

import {
  buildFlowPayload,
  postToFlow,
  type FlowPayload,
  type RequestRow,
} from "./power-automate";
import { routeRequest } from "@/lib/routing/engine";

const baseRequest: RequestRow = {
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
};

function payload(): FlowPayload {
  const routing = routeRequest({
    fundingSource: baseRequest.funding_source,
    amount: Number(baseRequest.amount),
    priority: baseRequest.priority,
    neededBy: baseRequest.needed_by,
    today: new Date(baseRequest.created_at),
  });
  return buildFlowPayload(baseRequest, routing, "https://finreq.local");
}

describe("postToFlow", () => {
  it("handles timeout followed by successful retry as confirmed delivery", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 202,
          headers: { "x-ms-workflow-run-id": "run-123" },
        }),
      );

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1],
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
    expect(result.runId).toBe("run-123");
  });

  it("keeps delivery status ambiguous for timeout followed by 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(
        new Response("server error", {
          status: 503,
        }),
      );

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1],
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.httpStatus).toBe(503);
  });

  it("treats exhausted 5xx retries as ambiguous delivery", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("server error", { status: 502 }))
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.httpStatus).toBe(500);
    expect(result.attempts).toBe(3);
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1, 1],
      sleep: async () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(false);
    expect(result.httpStatus).toBe(400);
  });

  it("returns ambiguous when retries exhaust after mixed transport/server uncertainty", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("server error", { status: 503 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("keeps ambiguity when a timeout is followed by HTTP 400", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    // 400 is still non-retryable: no third attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.httpStatus).toBe(400);
    expect(result.attempts).toBe(2);
  });

  it("keeps ambiguity when HTTP 503 is followed by HTTP 400", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.httpStatus).toBe(400);
    expect(result.attempts).toBe(2);
  });

  it("treats 429 followed by 400 as a definite rejection (429 is not ambiguous)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("throttled", { status: 429 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(false);
    expect(result.httpStatus).toBe(400);
  });

  it("treats exhausted transport-failure retries as ambiguous delivery", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"));

    const result = await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:1",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.uncertain).toBe(true);
    expect(result.httpStatus).toBeNull();
    expect(result.attempts).toBe(3);
  });

  it("reuses the same idempotency key across retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await postToFlow(payload(), {
      url: "https://example.com/flow",
      idempotencyKey: "req-1:9",
      fetchImpl,
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)["x-finreq-idempotency-key"]).toBe(
        "req-1:9",
      );
    }
  });
});
