import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({
  from: vi.fn(),
  upload: vi.fn(),
  session: vi.fn(),
  workflow: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: external.from,
    storage: { from: () => ({ upload: external.upload }) },
    auth: { getSession: external.session },
  },
}));
vi.mock("../workflow/initialize-workflow", () => ({ initializeWorkflow: external.workflow }));
vi.mock("./submission-service", () => ({ createSubmissionService: vi.fn(() => vi.fn()) }));

import { createSubmissionService } from "./submission-service";
import "./browser-submission";
import type { RequestPayload } from "../validation/gateways";

const ports = vi.mocked(createSubmissionService).mock.calls[0][0];
const payload: RequestPayload = {
  user_id: "11111111-2222-4333-8444-555555555555",
  request_number: "FR-2026-ABC123",
  title: "Lab equipment",
  requester_email: "faculty@howard.edu",
  department: "Computer Science",
  funding_source: "department",
  amount: 1200,
  needed_by: "2026-11-20",
  priority: "medium",
  description: "Lab equipment",
  grant_number: null,
  principal_investigator: null,
  university_program: null,
  status: "submitted",
  metadata: { schemaVersion: "1.0" },
};

describe("browser submission adapter", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes the validated payload and returns the saved row", async () => {
    const row = {
      id: "saved",
      request_number: payload.request_number,
      created_at: "2026-10-25T12:00:00Z",
    };
    const single = vi.fn().mockResolvedValue({ data: row, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    external.from.mockReturnValue({ insert });
    expect(await ports.insertRequest(payload)).toEqual(row);
    expect(external.from).toHaveBeenCalledWith("financial_requests");
    expect(insert).toHaveBeenCalledWith(payload);
    expect(select).toHaveBeenCalledWith("id, request_number, created_at");
  });

  it("propagates database errors so the service can map validation failures", async () => {
    const error = { code: "23514", hint: "financial_requests_amount_range" };
    external.from.mockReturnValue({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }),
    });
    await expect(ports.insertRequest(payload)).rejects.toBe(error);
  });

  it("looks up duplicate request numbers through the same typed table", async () => {
    const eq = vi.fn().mockReturnValue({ maybeSingle: async () => ({ data: null, error: null }) });
    external.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await ports.findRequest(payload.request_number)).toBeNull();
    expect(eq).toHaveBeenCalledWith("request_number", payload.request_number);
  });

  it("preserves returned upload errors and rejected transport promises", async () => {
    const file = new File(["quote"], "quote.pdf");
    const error = new Error("Rejected");
    external.upload.mockResolvedValueOnce({ error });
    expect(await ports.uploadAttachment("user/request/quote.pdf", file)).toEqual({ error });
    expect(external.upload).toHaveBeenCalledWith("user/request/quote.pdf", file, { upsert: false });
    external.upload.mockRejectedValueOnce(error);
    await expect(ports.uploadAttachment("path", file)).rejects.toBe(error);
  });

  it("preserves returned attachment linkage errors", async () => {
    const record = {
      request_id: "request",
      user_id: payload.user_id,
      file_name: "quote.pdf",
      file_path: "user/request/quote.pdf",
      file_size: 5,
      content_type: "application/pdf",
    };
    const error = new Error("Link rejected");
    const insert = vi.fn().mockResolvedValue({ error });
    external.from.mockReturnValue({ insert });
    expect(await ports.linkAttachment(record)).toEqual({ error });
    expect(external.from).toHaveBeenCalledWith("request_attachments");
    expect(insert).toHaveBeenCalledWith(record);
  });

  it("uses the existing storage keys, limits, and prototype attachment paths", () => {
    storage.set("prototype-financial-requests", JSON.stringify(Array(50).fill({ old: true })));
    const saved = ports.savePrototypeRequest(
      payload,
      payload.request_number,
      "2026-10-25T12:00:00Z",
    );
    const requests = JSON.parse(storage.get("prototype-financial-requests")!);
    expect(requests).toHaveLength(50);
    expect(requests[0]).toMatchObject({ ...payload, prototype: true, id: saved.id });
    storage.set("prototype-request-attachments", JSON.stringify(Array(100).fill({ old: true })));
    ports.savePrototypeAttachments(saved.id, payload.user_id, [new File(["a"], "quote.pdf")]);
    const files = JSON.parse(storage.get("prototype-request-attachments")!);
    expect(files).toHaveLength(100);
    expect(files[0]).toMatchObject({
      request_id: saved.id,
      user_id: payload.user_id,
      file_path: `prototype://${saved.id}/quote.pdf`,
      file_size: 1,
    });
  });

  it("does not write prototype attachment storage for an empty list", () => {
    ports.savePrototypeAttachments("request", payload.user_id, []);
    expect(storage.has("prototype-request-attachments")).toBe(false);
  });

  it("gets a fresh session and passes its authorization header to the server function", async () => {
    external.session.mockResolvedValue({ data: { session: { access_token: "fixture-token" } } });
    external.workflow.mockResolvedValue({ mode: "simulated" });
    expect(await ports.startWorkflow("saved")).toEqual({ mode: "simulated" });
    expect(external.workflow).toHaveBeenCalledWith({
      data: { requestId: "saved" },
      headers: { Authorization: "Bearer fixture-token" },
    });
  });

  it("stops workflow startup when there is no session", async () => {
    external.session.mockResolvedValue({ data: { session: null } });
    await expect(ports.startWorkflow("saved")).rejects.toThrow("No active session");
    expect(external.workflow).not.toHaveBeenCalled();
  });
});
