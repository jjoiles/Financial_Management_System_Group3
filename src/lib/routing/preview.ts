import { routeRequest, type RoutingDecision } from "@/lib/routing/engine";
import type { FundingSource } from "@/lib/validation/request-schema";

const FUNDING_SOURCES = ["department", "research", "university"];
const PRIORITIES = ["low", "medium", "high"];

/**
 * Live routing preview for the submit sidebar. Uses whatever the user has
 * typed so far; returns null until funding source and amount are usable.
 */
export function previewRouting(form: HTMLFormElement): RoutingDecision | null {
  const data = new FormData(form);
  const fundingSource = String(data.get("fundingSource") ?? "");
  const amount = Number(data.get("amount"));
  if (!FUNDING_SOURCES.includes(fundingSource) || !(amount > 0)) return null;
  const priority = String(data.get("priority") ?? "medium");
  return routeRequest({
    fundingSource: fundingSource as FundingSource,
    amount,
    priority: (PRIORITIES.includes(priority) ? priority : "medium") as "low" | "medium" | "high",
    neededBy: String(data.get("neededBy") || "9999-12-31"),
  });
}
