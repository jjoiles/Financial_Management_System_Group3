import { createSubmissionService } from "../src/lib/requests/submission-service";
import type { SubmissionPorts } from "../src/lib/requests/submission-types";

export const scenarios = [
  "success",
  "database validation",
  "prototype fallback",
  "workflow failure",
  "upload failure",
];
let scenario = scenarios[0];
export const selectScenario = (value: string) => {
  scenario = value;
};

const ports: SubmissionPorts = {
  async insertRequest(payload) {
    if (scenario === "database validation")
      throw { code: "23514", hint: "financial_requests_amount_range" };
    if (scenario === "prototype fallback") throw new Error("Fixture backend unavailable.");
    return {
      id: crypto.randomUUID(),
      request_number: payload.request_number,
      created_at: new Date().toISOString(),
    };
  },
  async findRequest() {
    return null;
  },
  async uploadAttachment() {
    return { error: scenario === "upload failure" ? new Error("Fixture upload rejected") : null };
  },
  async linkAttachment() {
    return { error: null };
  },
  savePrototypeRequest(_payload, requestNumber, createdAt) {
    return {
      id: crypto.randomUUID(),
      request_number: requestNumber,
      created_at: createdAt,
      prototype: true,
    };
  },
  savePrototypeAttachments() {},
  async startWorkflow() {
    return {
      mode: scenario === "workflow failure" ? "failed" : "simulated",
      alreadyInitialized: false,
      attempts: 0,
      routedTo: "",
      message:
        scenario === "workflow failure"
          ? "Fixture workflow rejected the request."
          : "Workflow simulated.",
    };
  },
  async wait() {},
  now: () => new Date(),
};

export const submitFinancialRequest = createSubmissionService(ports);
