import type { FundingSource, Priority } from "@/lib/validation/request-schema";
import {
  AMOUNT_TIERS,
  BASE_QUEUE,
  EXPEDITE_WITHIN_DAYS,
  QUEUES,
  QUEUE_ORDER,
  RULES_VERSION,
  type QueueId,
} from "./rules";

// F8: Intelligent Branching Routing Logic
//
// routeRequest() is a pure function: same input, same decision. It decides
//   - the first queue that receives the request (routed_to)
//   - the full ordered approval chain
//   - flags such as expedited or high value
//   - a plain-language reason for every branch taken
// The decision is stored in financial_requests.metadata.routing so reviewers
// and later features (notifications, SLA tracking) can read it.

export type RoutingInput = {
  fundingSource: FundingSource;
  amount: number;
  priority: Priority;
  neededBy: string; // YYYY-MM-DD
  today?: Date;
};

export type RoutingFlag = "expedited" | "high_value" | "multi_level";

export type ApprovalStep = {
  step: number;
  queue: QueueId;
  label: string;
  reason: string;
};

export type RoutingDecision = {
  primaryQueue: QueueId;
  primaryLabel: string;
  approvalChain: ApprovalStep[];
  flags: RoutingFlag[];
  reasons: string[];
  rulesVersion: string;
  decidedAt: string;
};

const fundingLabel: Record<FundingSource, string> = {
  department: "Department",
  research: "Research (R)",
  university: "University (U)",
};

const MS_PER_DAY = 86_400_000;

export const daysUntil = (dateString: string, today: Date = new Date()) => {
  const due = new Date(`${dateString}T00:00:00`);
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - start.getTime()) / MS_PER_DAY);
};

export function routeRequest(input: RoutingInput): RoutingDecision {
  const today = input.today ?? new Date();
  const reasons: string[] = [];
  const steps = new Map<QueueId, string>();

  // Branch 1: funding source picks the base queue.
  const base = BASE_QUEUE[input.fundingSource];
  steps.set(base, `${fundingLabel[input.fundingSource]} funding is reviewed by ${QUEUES[base]}.`);
  reasons.push(steps.get(base)!);

  // Branch 2: amount tiers add approvers.
  const amount = Number.isFinite(input.amount) ? input.amount : 0;
  for (const tier of AMOUNT_TIERS) {
    if (
      amount >= tier.minAmount &&
      tier.appliesTo.includes(input.fundingSource) &&
      !steps.has(tier.queue)
    ) {
      steps.set(tier.queue, tier.reason);
      reasons.push(tier.reason);
    }
  }

  // Branch 3: urgency.
  const flags: RoutingFlag[] = [];
  const days = daysUntil(input.neededBy, today);
  if (input.priority === "high") {
    flags.push("expedited");
    reasons.push("High priority, so the request is expedited.");
  } else if (Number.isFinite(days) && days <= EXPEDITE_WITHIN_DAYS) {
    flags.push("expedited");
    reasons.push(`Needed within ${EXPEDITE_WITHIN_DAYS} days, so the request is expedited.`);
  }

  const approvalChain = [...steps.entries()]
    .sort(([a], [b]) => QUEUE_ORDER[a] - QUEUE_ORDER[b])
    .map(([queue, reason], i) => ({
      step: i + 1,
      queue,
      label: QUEUES[queue],
      reason,
    }));

  if (steps.has("cfo_office")) flags.push("high_value");
  if (approvalChain.length > 1) flags.push("multi_level");

  return {
    primaryQueue: approvalChain[0].queue,
    primaryLabel: approvalChain[0].label,
    approvalChain,
    flags,
    reasons,
    rulesVersion: RULES_VERSION,
    decidedAt: today.toISOString(),
  };
}

// Given how many steps are already approved, returns the next approver or
// null when the chain is complete. A rejection at any step ends the chain;
// callers handle that by status, not here.
export function getNextApprovalStep(
  decision: Pick<RoutingDecision, "approvalChain">,
  approvedSteps: number,
): ApprovalStep | null {
  return decision.approvalChain[approvedSteps] ?? null;
}

// Reads a stored decision back from request metadata. Returns null for
// requests created before F8.
export function readRoutingDecision(
  metadata: Record<string, unknown> | null | undefined,
): RoutingDecision | null {
  const routing = metadata?.routing as RoutingDecision | undefined;
  if (!routing || !Array.isArray(routing.approvalChain)) return null;
  return routing;
}
