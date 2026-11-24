import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { routeRequest } from "@/lib/routing/engine";
import type { RoutingDecision } from "@/lib/routing/engine";
import {
  FLOW_SCHEMA_VERSION,
  buildFlowPayload,
  isAllowedFlowUrl,
  postToFlow,
  signBody,
  type RequestRow,
} from "./power-automate";

const requestRow = (overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: "request-123",
  request_number: "FR-2026-ABC123",
  user_id: "user-456",
  title: "Research equipment",
  requester_email: "person@howard.edu",
  department: "Computer Science",
  funding_source: "department",
  amount: "1250.50",
  needed_by: "2026-12-01",
  priority: "medium",
  grant_number: null,
  principal_investigator: null,
  university_program: null,
  status: "submitted",
  created_at: "2026-11-24T15:30:00.000Z",
  ...overrides,
});

const routingDecision = (): RoutingDecision =>
  routeRequest({
    fundingSource: "department",
    amount: 500,
    priority: "medium",
    neededBy: "2026-12-01",
    today: new Date("2026-11-24T12:00:00.000Z"),
  });

const response = (status: number, runId?: string) =>
  new Response(null, {
    status,
    headers: runId ? { "x-ms-workflow-run-id": runId } : undefined,
  });

function createFetch(...results: Array<Response | Error>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const result of results) {
    if (result instanceof Error) {
      fetchMock.mockRejectedValueOnce(result);
    } else {
      fetchMock.mockResolvedValueOnce(result);
    }
  }
  return fetchMock;
}

describe("F7 Power Automate payload construction", () => {
  it("maps request data and routing into the versioned event contract", () => {
    const result = buildFlowPayload(
      requestRow(),
      routingDecision(),
      "https://finreq.example",
    );

    expect(result).toMatchObject({
      schemaVersion: FLOW_SCHEMA_VERSION,
      event: "request.submitted",
      requestId: "request-123",
      requestNumber: "FR-2026-ABC123",
      submittedAt: "2026-11-24T15:30:00.000Z",
      status: "submitted",
      requester: {
        userId: "user-456",
        email: "person@howard.edu",
      },
      department: "Computer Science",
      fundingSource: "department",
      amount: 1250.5,
      currency: "USD",
      neededBy: "2026-12-01",
      priority: "medium",
      title: "Research equipment",
      research: null,
      universityProgram: null,
      appUrl: "https://finreq.example/requests?id=FR-2026-ABC123",
    });
    expect(result.routing.approvalChain).toEqual(
      routingDecision().approvalChain.map(({ step, queue, label }) => ({
        step,
        queue,
        label,
      })),
    );
  });

  it("includes grant and principal-investigator data for Research requests", () => {
    const result = buildFlowPayload(
      requestRow({
        funding_source: "research",
        grant_number: "GRANT-2026-01",
        principal_investigator: "Dr. Taylor",
      }),
      routingDecision(),
    );

    expect(result.research).toEqual({
      grantNumber: "GRANT-2026-01",
      principalInvestigator: "Dr. Taylor",
    });
  });

  it("does not include Research details for a non-Research funding source", () => {
    const result = buildFlowPayload(
      requestRow({
        funding_source: "university",
        grant_number: "SHOULD-NOT-BE-SENT",
        principal_investigator: "Dr. Example",
      }),
      routingDecision(),
    );

    expect(result.research).toBeNull();
  });

  it("removes a trailing slash and URL-encodes the request number in appUrl", () => {
    const result = buildFlowPayload(
      requestRow({ request_number: "FR 2026/#1" }),
      routingDecision(),
      "https://finreq.example/",
    );

    expect(result.appUrl).toBe(
      "https://finreq.example/requests?id=FR%202026%2F%231",
    );
  });

  it("sets appUrl to null when no application base URL is supplied", () => {
    expect(buildFlowPayload(requestRow(), routingDecision()).appUrl).toBeNull();
  });
});

describe("F7 Power Automate request signing and URL validation", () => {
  it("creates the expected HMAC-SHA256 hex signature", async () => {
    const body = '{"event":"request.submitted"}';
    const secret = "test-shared-secret";

    const signature = await signBody(body, secret);
    const expected = createHmac("sha256", secret).update(body).digest("hex");

    expect(signature).toBe(expected);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the signature when the body changes", async () => {
    const first = await signBody('{"amount":100}', "test-shared-secret");
    const second = await signBody('{"amount":200}', "test-shared-secret");

    expect(first).not.toBe(second);
  });

  it("allows HTTPS flow URLs", () => {
    expect(isAllowedFlowUrl("https://flows.example.com/trigger")).toBe(true);
  });

  it.each([
    "http://flows.example.com/trigger",
    "not-a-url",
    "//flows.example.com/trigger",
  ])("rejects non-HTTPS or malformed URL: %s", (url) => {
    expect(isAllowedFlowUrl(url)).toBe(false);
  });
});

describe("F7 Power Automate POST behavior", () => {
  it("does not make a network request for an insecure flow URL", async () => {
    const fetchImpl = createFetch(response(200, "run-123"));

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "http://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
      },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: null,
      attempts: 0,
      error: "Flow URL must be https.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the run ID from a successful flow response", async () => {
    const fetchImpl = createFetch(response(202, "run-abc"));

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
      },
    );

    expect(result).toEqual({
      ok: true,
      httpStatus: 202,
      attempts: 1,
      runId: "run-abc",
    });
  });

  it("returns a null run ID when the successful response has no run ID header", async () => {
    const fetchImpl = createFetch(response(200));

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      attempts: 1,
      runId: null,
    });
  });

  it("sends the idempotency key, schema version, JSON body, and HMAC signature", async () => {
    const fetchImpl = createFetch(response(200));
    const payload = buildFlowPayload(requestRow(), routingDecision());
    const body = JSON.stringify(payload);
    const secret = "test-shared-secret";

    await postToFlow(payload, {
      url: "https://flows.example.com/trigger",
      secret,
      idempotencyKey: "request-123",
      fetchImpl,
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;

    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(body);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-finreq-idempotency-key"]).toBe("request-123");
    expect(headers["x-finreq-schema-version"]).toBe(
      String(FLOW_SCHEMA_VERSION),
    );
    expect(headers["x-finreq-signature"]).toBe(
      createHmac("sha256", secret).update(body).digest("hex"),
    );
  });

  it("does not add a signature header when no shared secret is configured", async () => {
    const fetchImpl = createFetch(response(200));

    await postToFlow(buildFlowPayload(requestRow(), routingDecision()), {
      url: "https://flows.example.com/trigger",
      idempotencyKey: "request-123",
      fetchImpl,
    });

    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["x-finreq-signature"]).toBeUndefined();
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const fetchImpl = createFetch(response(400), response(200));
    const sleep = vi.fn(async (_delay: number) => undefined);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        retryDelaysMs: [10],
        sleep,
      },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: 400,
      attempts: 1,
      error: "Flow returned HTTP 400.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries HTTP 429 and succeeds on the next attempt", async () => {
    const fetchImpl = createFetch(response(429), response(202, "run-429"));
    const sleep = vi.fn(async (_delay: number) => undefined);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        retryDelaysMs: [25],
        sleep,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 202,
      attempts: 2,
      runId: "run-429",
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries server errors and succeeds when the flow becomes available", async () => {
    const fetchImpl = createFetch(
      response(503),
      response(502),
      response(200, "run-recovered"),
    );
    const sleep = vi.fn(async (_delay: number) => undefined);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        retryDelaysMs: [10, 20],
        sleep,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      attempts: 3,
      runId: "run-recovered",
    });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
  });

  it("retries a network error and succeeds on the next attempt", async () => {
    const fetchImpl = createFetch(
      new Error("network unavailable"),
      response(200, "run-network-recovered"),
    );
    const sleep = vi.fn(async (_delay: number) => undefined);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        retryDelaysMs: [5],
        sleep,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      runId: "run-network-recovered",
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("reports timeout aborts with the configured timeout duration", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "AbortError";
    const fetchImpl = createFetch(timeoutError);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        timeoutMs: 2_500,
        retryDelaysMs: [],
      },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: null,
      attempts: 1,
      error: "Flow did not respond within 2.5s.",
    });
  });

  it("returns the final HTTP failure after exhausting all configured attempts", async () => {
    const fetchImpl = createFetch(response(503), response(502), response(504));
    const sleep = vi.fn(async (_delay: number) => undefined);

    const result = await postToFlow(
      buildFlowPayload(requestRow(), routingDecision()),
      {
        url: "https://flows.example.com/trigger",
        idempotencyKey: "request-123",
        fetchImpl,
        retryDelaysMs: [10, 20],
        sleep,
      },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: 504,
      attempts: 3,
      error: "Flow returned HTTP 504.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
  });
});
