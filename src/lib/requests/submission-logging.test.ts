import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLogSink, type LogEntry } from "../logger";
import { createSubmissionService } from "./submission-service";
import type { SubmissionCommand, SubmissionPorts } from "./submission-types";

// F5.4.3 (#283): a failed insert is logged as an error with the error details.
// Kept in its own file so it does not overlap with submission-service.test.ts.
// Matches any "request.insert_failed*" event so it holds with or without the
// prototype fallback (#173 renames the event to request.insert_failed).

const NOW = new Date("2026-10-25T12:00:00Z");

function setup() {
  // Cast because the port list differs with and without the prototype fallback.
  const ports = {
    insertRequest: vi.fn().mockRejectedValue(new Error("insert rejected by test")),
    findRequest: vi.fn().mockResolvedValue(null),
    uploadAttachment: vi.fn().mockResolvedValue({ error: null }),
    linkAttachment: vi.fn().mockResolvedValue({ error: null }),
    savePrototypeRequest: vi.fn().mockReturnValue({
      id: "saved-id",
      request_number: "FR-2026-ABC123",
      created_at: NOW.toISOString(),
      prototype: true,
    }),
    savePrototypeAttachments: vi.fn(),
    startWorkflow: vi.fn().mockResolvedValue({
      mode: "simulated",
      alreadyInitialized: false,
      attempts: 0,
      routedTo: "Department Budget Reviewer",
      message: "Workflow simulated.",
    }),
    wait: vi.fn().mockResolvedValue(undefined),
    now: () => NOW,
  } as unknown as SubmissionPorts;
  const command: SubmissionCommand = {
    userId: "11111111-2222-4333-8444-555555555555",
    values: {
      requesterEmail: "faculty@howard.edu",
      department: "Computer Science",
      fundingSource: "department",
      amount: "1200.50",
      neededBy: "2026-11-20",
      priority: "medium",
      description: "Equipment for the teaching lab.",
    },
    files: [],
  };
  return { command, submit: createSubmissionService(ports) };
}

describe("F5.4.3 (#283): failed submit logging", () => {
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

  it("logs a failed insert as an error with the request number and error", async () => {
    const { submit, command } = setup();
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push(entry));
    try {
      await submit(command);
    } finally {
      remove();
    }
    const failed = entries.find((entry) => entry.event.startsWith("request.insert_failed"));
    expect(failed).toMatchObject({
      level: "error",
      context: { requestNumber: expect.stringMatching(/^FR-2026-/) },
    });
    expect(JSON.stringify(failed?.context.error)).toContain("insert rejected by test");
  });
});
