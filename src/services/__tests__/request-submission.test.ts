import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake Supabase client: each test sets the responses it needs in `backend`.
const { backend, initializeWorkflow } = vi.hoisted(() => {
  const backend = {
    insertResponses: [] as { data?: unknown; error: unknown }[],
    existingRow: { data: null as unknown, error: null as unknown },
    uploadResponse: { error: null as unknown },
    attachmentResponse: { error: null as unknown },
    insertedPayloads: [] as Record<string, unknown>[],
    uploadedPaths: [] as string[],
  };
  return { backend, initializeWorkflow: vi.fn() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "financial_requests") {
        return {
          insert: (payload: Record<string, unknown>) => {
            backend.insertedPayloads.push(payload);
            return { select: () => ({ single: async () => backend.insertResponses.shift() }) };
          },
          select: () => ({ eq: () => ({ maybeSingle: async () => backend.existingRow }) }),
        };
      }
      return { insert: async () => backend.attachmentResponse };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          backend.uploadedPaths.push(path);
          return backend.uploadResponse;
        },
      }),
    },
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  },
}));

vi.mock("@/lib/workflow/initialize-workflow", () => ({ initializeWorkflow }));

import { submitFinancialRequest } from "../request-submission";
import { validateSubmission } from "@/lib/validation/gateways";
import { PROTOTYPE_REQUESTS_KEY } from "@/lib/prototype-store";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const savedRow = {
  id: "row-1",
  request_number: "FR-2026-ABC123",
  created_at: "2026-10-25T12:00:00Z",
};

function validInput() {
  const parsed = validateSubmission({
    requesterEmail: "student@howard.edu",
    department: "Chemistry",
    amount: "500",
    fundingSource: "department",
    neededBy: "2030-01-15",
    priority: "medium",
    description: "Lab supplies for the fall semester",
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.data;
}

const file = (name: string) => new File(["receipt"], name, { type: "application/pdf" });

beforeEach(() => {
  backend.insertResponses = [];
  backend.existingRow = { data: null, error: null };
  backend.uploadResponse = { error: null };
  backend.attachmentResponse = { error: null };
  backend.insertedPayloads = [];
  backend.uploadedPaths = [];
  initializeWorkflow.mockReset();
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

describe("submitFinancialRequest", () => {
  it("saves the request, uploads attachments, and starts the workflow", async () => {
    backend.insertResponses = [{ data: savedRow, error: null }];
    initializeWorkflow.mockResolvedValue({
      mode: "simulated",
      alreadyInitialized: false,
      routedTo: "Department Chair",
      message: "",
    });

    const outcome = await submitFinancialRequest({
      input: validInput(),
      userId: USER_ID,
      files: [file("quote.pdf")],
    });

    expect(outcome.kind).toBe("submitted");
    if (outcome.kind !== "submitted") return;
    expect(outcome.result).toMatchObject({
      id: "FR-2026-ABC123",
      routedTo: "Department Chair",
      workflow: "Simulated (flow not connected)",
      warning: "",
    });
    expect(backend.insertedPayloads[0]).toMatchObject({
      user_id: USER_ID,
      funding_source: "department",
      amount: 500,
      status: "submitted",
    });
    expect(backend.uploadedPaths[0]).toMatch(
      /^11111111-1111-4111-8111-111111111111\/row-1\/\d+-quote\.pdf$/,
    );
    expect(initializeWorkflow).toHaveBeenCalledWith({
      data: { requestId: "row-1" },
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("returns field errors when the database rejects a field", async () => {
    backend.insertResponses = [{ error: { code: "23514", message: "violates check constraint" } }];

    const outcome = await submitFinancialRequest({
      input: validInput(),
      userId: USER_ID,
      files: [],
    });

    expect(outcome.kind).toBe("field_errors");
    if (outcome.kind !== "field_errors") return;
    expect(outcome.message).toBe(
      "The server rejected one or more fields. Review the highlighted fields.",
    );
    expect(initializeWorkflow).not.toHaveBeenCalled();
  });

  it("falls back to prototype mode when the insert fails for another reason", async () => {
    backend.insertResponses = [{ error: { code: "42501", message: "permission denied" } }];

    const outcome = await submitFinancialRequest({
      input: validInput(),
      userId: USER_ID,
      files: [file("receipt.pdf")],
    });

    expect(outcome.kind).toBe("submitted");
    if (outcome.kind !== "submitted") return;
    expect(outcome.result.workflow).toBe("Simulated (prototype mode)");
    expect(outcome.result.warning).toMatch(/^Saved in prototype mode\./);
    const stored = JSON.parse(window.localStorage.getItem(PROTOTYPE_REQUESTS_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].prototype).toBe(true);
    expect(backend.uploadedPaths).toHaveLength(0);
    expect(initializeWorkflow).not.toHaveBeenCalled();
  });

  it("keeps the first warning when several follow-up steps fail", async () => {
    backend.insertResponses = [{ data: savedRow, error: null }];
    backend.uploadResponse = { error: { message: "bucket missing" } };
    initializeWorkflow.mockResolvedValue({
      mode: "failed",
      alreadyInitialized: false,
      routedTo: "",
      message: "Flow returned 500",
    });

    const outcome = await submitFinancialRequest({
      input: validInput(),
      userId: USER_ID,
      files: [file("a.pdf"), file("b.pdf")],
    });

    if (outcome.kind !== "submitted") throw new Error("expected submitted");
    expect(outcome.result.warning).toBe(
      "Your request was saved, but one or more attachments could not be uploaded, so attachment storage was simulated.",
    );
    expect(outcome.result.workflow).toBe("Not started");
  });

  it("returns the existing row when a retried insert hits a duplicate request number", async () => {
    backend.insertResponses = [{ error: { code: "23505", message: "duplicate key" } }];
    backend.existingRow = { data: savedRow, error: null };
    initializeWorkflow.mockResolvedValue({
      mode: "power_automate",
      alreadyInitialized: true,
      routedTo: "Department Chair",
      message: "",
    });

    const outcome = await submitFinancialRequest({
      input: validInput(),
      userId: USER_ID,
      files: [],
    });

    if (outcome.kind !== "submitted") throw new Error("expected submitted");
    expect(outcome.result.id).toBe("FR-2026-ABC123");
    expect(outcome.result.workflow).toBe("Started in Power Automate");
  });
});
