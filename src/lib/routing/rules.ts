import type { FundingSource } from "@/lib/validation/request-schema";

// F8 routing rules. Every threshold and queue name lives here so the team can
// change business rules without touching the engine or the UI.
// Bump RULES_VERSION whenever a rule changes; it is saved with each decision.

export const RULES_VERSION = "2026-10-15.1";

export type QueueId =
  | "department_budget"
  | "research_admin"
  | "provost_finance"
  | "sponsored_programs"
  | "dean_office"
  | "cfo_office";

export const QUEUES: Record<QueueId, string> = {
  department_budget: "Department Budget Reviewer",
  research_admin: "Research Administration",
  provost_finance: "Provost Finance Office",
  sponsored_programs: "Office of Sponsored Programs",
  dean_office: "Dean's Office",
  cfo_office: "Office of the CFO",
};

// First reviewer for each funding source.
export const BASE_QUEUE: Record<FundingSource, QueueId> = {
  department: "department_budget",
  research: "research_admin",
  university: "provost_finance",
};

// Amount tiers add approvers on top of the base queue. Amounts in USD,
// inclusive (>=).
export const AMOUNT_TIERS: {
  minAmount: number;
  queue: QueueId;
  appliesTo: FundingSource[];
  reason: string;
}[] = [
  {
    minAmount: 5_000,
    queue: "dean_office",
    appliesTo: ["department", "university"],
    reason: "Amount is $5,000 or more, so the Dean's Office must approve.",
  },
  {
    minAmount: 25_000,
    queue: "sponsored_programs",
    appliesTo: ["research"],
    reason: "Research request of $25,000 or more needs sponsored-programs compliance review.",
  },
  {
    minAmount: 25_000,
    queue: "cfo_office",
    appliesTo: ["department", "research", "university"],
    reason: "Amount is $25,000 or more, so the Office of the CFO must approve.",
  },
];

// A request is expedited when it is high priority or due within this many days.
export const EXPEDITE_WITHIN_DAYS = 3;

// Approval order when several queues apply. Lower runs first.
export const QUEUE_ORDER: Record<QueueId, number> = {
  department_budget: 10,
  research_admin: 10,
  provost_finance: 10,
  sponsored_programs: 20,
  dean_office: 30,
  cfo_office: 40,
};
