import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentLogs } from "../logger";
import { createSubmissionService } from "./submission-service";
import type { SubmissionCommand, SubmissionPorts } from "./submission-types";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-25T12:00:00Z");
const saved = { id: "saved-id", request_number: "FR-2026-ABC123", created_at: NOW.toISOString() };

function setup() {
  const ports = {
    insertRequest: vi.fn<SubmissionPorts["insertRequest"]>().mockResolvedValue(saved),
    findRequest: vi.fn<SubmissionPorts["findRequest"]>().mockResolvedValue(null),
    uploadAttachment: vi
      .fn<SubmissionPorts["uploadAttachment"]>()
      .mockResolvedValue({ error: null }),
    linkAttachment: vi.fn<SubmissionPorts["linkAttachment"]>().mockResolvedValue({ error: null }),
    startWorkflow: vi.fn<SubmissionPorts["startWorkflow"]>().mockResolvedValue({
      mode: "simulated",
      alreadyInitialized: false,
      attempts: 0,
      routedTo: "Department Budget Reviewer",
      message: "Workflow simulated.",
    }),
    wait: vi.fn<SubmissionPorts["wait"]>().mockResolvedValue(undefined),
    now: () => NOW,
  } satisfies SubmissionPorts;
  const command: SubmissionCommand = {
    userId: USER_ID,
    values: {
      requesterEmail: " Faculty@Howard.edu ",
      department: " Computer Science ",
      fundingSource: "department",
      amount: "1200.50",
      neededBy: "2026-11-20",
      priority: "medium",
      description: "Equipment for the teaching lab.",
    },
    files: [],
  };
  return { ports, command, submit: createSubmissionService(ports) };
}

describe("request submission behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires a signed-in user before any persistence", async () => {
    const { submit, ports, command } = setup();
    const outcome = await submit({ ...command, userId: null });
    expect(outcome).toEqual({
      ok: false,
      errors: {},
      message: "Please sign in before submitting a financial request.",
    });
    expect(ports.insertRequest).not.toHaveBeenCalled();
  });

  it("returns field errors without writing an invalid form", async () => {
    const { submit, ports, command } = setup();
    const outcome = await submit({
      ...command,
      values: { ...command.values, amount: "-1", requesterEmail: "user@example.com" },
    });
    expect(outcome).toMatchObject({
      ok: false,
      errors: { amount: expect.any(String), requesterEmail: expect.any(String) },
      message: "",
    });
    expect(ports.insertRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["research", "grantNumber"],
    ["university", "universityProgram"],
  ])("retains conditional requirements for %s funding", async (fundingSource, field) => {
    const { submit, ports, command } = setup();
    expect(
      await submit({ ...command, values: { ...command.values, fundingSource } }),
    ).toMatchObject({ ok: false, errors: { [field]: expect.any(String) } });
    expect(ports.insertRequest).not.toHaveBeenCalled();
  });

  it("normalizes input, clears irrelevant fields, and links generated metadata", async () => {
    const { submit, ports, command } = setup();
    const outcome = await submit({
      ...command,
      values: { ...command.values, grantNumber: "stale", universityProgram: "stale" },
    });
    expect(ports.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        requester_email: "faculty@howard.edu",
        department: "Computer Science",
        amount: 1200.5,
        grant_number: null,
        principal_investigator: null,
        university_program: null,
        metadata: expect.objectContaining({
          userId: USER_ID,
          requestNumber: expect.stringMatching(/^FR-2026-[A-Z0-9]{6}$/),
          attachmentCount: 0,
        }),
      }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { id: saved.request_number, workflow: "Simulated (flow not connected)", warning: "" },
    });
  });

  it("preserves research routing, PI normalization, and grant metadata", async () => {
    const { submit, ports, command } = setup();
    await submit({
      ...command,
      values: {
        ...command.values,
        fundingSource: "research",
        grantNumber: "GR-123",
        principalInvestigator: "Ada Lovelace",
      },
    });
    expect(ports.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        routed_to: "Research Administration",
        principal_investigator: "Dr. Ada Lovelace",
        grant_number: "GR-123",
        metadata: expect.objectContaining({
          derived: expect.objectContaining({ requiresGrantValidation: true }),
        }),
      }),
    );
  });

  it("uploads and links files before starting the workflow", async () => {
    const { submit, ports, command } = setup();
    const file = new File(["quote"], "../Lab quote.pdf", { type: "application/pdf" });
    await submit({ ...command, files: [file] });
    const path = `${USER_ID}/${saved.id}/${NOW.getTime()}-Lab_quote.pdf`;
    expect(ports.uploadAttachment).toHaveBeenCalledWith(path, file);
    expect(ports.linkAttachment).toHaveBeenCalledWith({
      request_id: saved.id,
      user_id: USER_ID,
      file_name: file.name,
      file_path: path,
      file_size: file.size,
      content_type: "application/pdf",
    });
    expect(ports.insertRequest.mock.invocationCallOrder[0]).toBeLessThan(
      ports.uploadAttachment.mock.invocationCallOrder[0],
    );
    expect(ports.linkAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      ports.startWorkflow.mock.invocationCallOrder[0],
    );
    expect(ports.insertRequest.mock.calls[0][0].metadata).toMatchObject({
      attachmentCount: 1,
      derived: { totalAttachmentBytes: file.size },
      attachments: [{ safeFileName: "Lab_quote.pdf" }],
    });
  });

  it("retries transient insert errors using the existing backoff", async () => {
    const { submit, ports, command } = setup();
    ports.insertRequest
      .mockRejectedValueOnce({ code: "PGRST000" })
      .mockRejectedValueOnce({ status: 503 });
    expect(await submit(command)).toMatchObject({ ok: true });
    expect(ports.insertRequest).toHaveBeenCalledTimes(3);
    expect(ports.wait.mock.calls).toEqual([[800], [1600]]);
  });

  it("stops retrying after six attempts and returns a backend error", async () => {
    const { submit, ports, command } = setup();
    ports.insertRequest.mockRejectedValue({ message: "schema cache unavailable" });
    expect(await submit(command)).toEqual({
      ok: false,
      errors: {},
      message:
        "The request could not be saved because the backend was temporarily unavailable. Please try again in a moment.",
    });
    expect(ports.insertRequest).toHaveBeenCalledTimes(6);
    expect(ports.wait.mock.calls).toEqual([[800], [1600], [3200], [6400], [8000]]);
    expect(ports.startWorkflow).not.toHaveBeenCalled();
  });

  it("recovers a duplicate insert by request number", async () => {
    const { submit, ports, command } = setup();
    ports.insertRequest.mockRejectedValue({ code: "23505" });
    ports.findRequest.mockResolvedValue(saved);
    expect(await submit(command)).toMatchObject({ ok: true });
    expect(ports.findRequest).toHaveBeenCalledWith(expect.stringMatching(/^FR-2026-/));
  });

  it("returns an error when a duplicate cannot be recovered", async () => {
    const { submit, ports, command } = setup();
    ports.insertRequest.mockRejectedValue({ code: "23505" });
    ports.findRequest.mockRejectedValue(new Error("Lookup unavailable"));
    expect(await submit(command)).toEqual({
      ok: false,
      errors: {},
      message:
        "The request could not be saved. Please try again. If the problem continues, contact the FinReq team.",
    });
    expect(ports.wait).not.toHaveBeenCalled();
    expect(ports.startWorkflow).not.toHaveBeenCalled();
  });

  it.each(["23514", "P0001", "22P02"])(
    "does not turn database validation error %s into a generic failure",
    async (code) => {
      const { submit, ports, command } = setup();
      ports.insertRequest.mockRejectedValue({ code, hint: "financial_requests_amount_range" });
      expect(await submit(command)).toMatchObject({
        ok: false,
        errors: { amount: expect.any(String) },
        message: "The server rejected one or more fields. Review the highlighted fields.",
      });
      expect(ports.uploadAttachment).not.toHaveBeenCalled();
      expect(ports.startWorkflow).not.toHaveBeenCalled();
    },
  );

  it("shows an error and logs it when the insert fails, without saving locally", async () => {
    const { submit, ports, command } = setup();
    const insertError = new Error("permission denied for function is_admin_or_reviewer");
    ports.insertRequest.mockRejectedValue(insertError);
    const files = [new File(["a"], "a.pdf")];
    expect(await submit({ ...command, files })).toEqual({
      ok: false,
      errors: {},
      message:
        "The request could not be saved. Please try again. If the problem continues, contact the FinReq team.",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[finreq] request.insert_failed",
      expect.objectContaining({ requestNumber: expect.stringMatching(/^FR-2026-/) }),
    );
    expect(getRecentLogs().at(-1)).toMatchObject({
      level: "error",
      event: "request.insert_failed",
      context: { error: expect.objectContaining({ message: insertError.message }) },
    });
    expect(ports.uploadAttachment).not.toHaveBeenCalled();
    expect(ports.startWorkflow).not.toHaveBeenCalled();
  });

  it("continues after a returned upload error and links only successful files", async () => {
    const { submit, ports, command } = setup();
    ports.uploadAttachment.mockResolvedValueOnce({ error: new Error("Rejected") });
    const files = [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")];
    expect(await submit({ ...command, files })).toMatchObject({
      ok: true,
      result: {
        warning: "Your request was saved, but one or more attachments could not be uploaded.",
      },
    });
    expect(ports.linkAttachment).toHaveBeenCalledTimes(1);
    expect(ports.linkAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ file_name: "b.pdf" }),
    );
    expect(ports.startWorkflow).toHaveBeenCalled();
  });

  it("retains an attachment link warning and starts the workflow", async () => {
    const { submit, ports, command } = setup();
    ports.linkAttachment.mockResolvedValue({ error: new Error("Link rejected") });
    expect(await submit({ ...command, files: [new File(["a"], "a.pdf")] })).toMatchObject({
      ok: true,
      result: {
        warning: "Your request was saved, but one or more attachments could not be linked to it.",
      },
    });
    expect(ports.startWorkflow).toHaveBeenCalled();
  });

  it.each(["uploadAttachment", "linkAttachment"] as const)(
    "warns that attachments were not uploaded when %s throws",
    async (method) => {
      const { submit, ports, command } = setup();
      ports[method].mockRejectedValue(new Error("Network failed"));
      const files = [new File(["a"], "a.pdf")];
      expect(await submit({ ...command, files })).toMatchObject({
        ok: true,
        result: {
          warning:
            "Your request was saved, but attachment storage is not available right now, so attachments were not uploaded.",
        },
      });
      expect(ports.startWorkflow).toHaveBeenCalled();
    },
  );

  it("uses the server workflow route and live workflow label", async () => {
    const { submit, ports, command } = setup();
    ports.startWorkflow.mockResolvedValue({
      mode: "power_automate",
      alreadyInitialized: false,
      attempts: 1,
      routedTo: "Research Administration",
      message: "Started",
    });
    expect(await submit(command)).toMatchObject({
      ok: true,
      result: {
        routedTo: "Research Administration",
        workflow: "Started in Power Automate",
      },
    });
  });

  it("retains saved requests when the workflow reports failure", async () => {
    const { submit, ports, command } = setup();
    ports.startWorkflow.mockResolvedValue({
      mode: "failed",
      alreadyInitialized: false,
      attempts: 3,
      routedTo: "",
      message: "Flow rejected",
    });
    expect(await submit(command)).toMatchObject({
      ok: true,
      result: {
        routedTo: "Department Budget Reviewer",
        workflow: "Not started",
        warning: "Flow rejected",
      },
    });
    expect(ports.insertRequest).toHaveBeenCalledTimes(1);
  });

  it("retains saved requests and explains thrown workflow errors", async () => {
    const { submit, ports, command } = setup();
    ports.startWorkflow.mockRejectedValue(new Error("No active session"));
    expect(await submit(command)).toMatchObject({
      ok: true,
      result: {
        workflow: "Not started",
        warning:
          "Your request was saved, but the workflow could not be started. It can be retried without resubmitting.",
      },
    });
  });

  it("preserves the first warning when attachments and workflow both fail", async () => {
    const { submit, ports, command } = setup();
    ports.uploadAttachment.mockResolvedValue({ error: new Error("Rejected") });
    ports.startWorkflow.mockRejectedValue(new Error("Offline"));
    const outcome = await submit({ ...command, files: [new File(["a"], "a.pdf")] });
    expect(outcome).toMatchObject({
      ok: true,
      result: { warning: expect.stringContaining("could not be uploaded") },
    });
  });

  it("blocks mislinked metadata before persistence", async () => {
    const { submit, ports, command } = setup();
    expect(await submit({ ...command, userId: "invalid-id" })).toMatchObject({
      ok: false,
      message:
        "Request metadata could not be linked to your account. Please refresh and try again.",
    });
    expect(ports.insertRequest).not.toHaveBeenCalled();
  });
});
