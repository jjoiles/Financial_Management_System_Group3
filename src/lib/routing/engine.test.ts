import { describe, expect, it } from "vitest";
import { daysUntil, getNextApprovalStep, readRoutingDecision, routeRequest } from "./engine";

const TODAY = new Date("2026-10-15T12:00:00.000Z");

describe("request routing engine", () => {
  it("routes a standard department request to the Department Budget Reviewer", () => {
    const decision = routeRequest({
      fundingSource: "department",
      amount: 1200,
      priority: "medium",
      neededBy: "2026-11-20",
      today: TODAY,
    });

    expect(decision.primaryQueue).toBe("department_budget");
    expect(decision.primaryLabel).toBe("Department Budget Reviewer");
    expect(decision.approvalChain).toHaveLength(1);
    expect(decision.flags).toEqual([]);
  });

  it("adds the Dean's Office for department requests of $5,000 or more", () => {
    const decision = routeRequest({
      fundingSource: "department",
      amount: 5000,
      priority: "medium",
      neededBy: "2026-11-20",
      today: TODAY,
    });

    expect(decision.approvalChain.map((step) => step.queue)).toEqual([
      "department_budget",
      "dean_office",
    ]);
    expect(decision.flags).toContain("multi_level");
  });

  it("adds compliance and CFO approval for research requests of $25,000 or more", () => {
    const decision = routeRequest({
      fundingSource: "research",
      amount: 30000,
      priority: "medium",
      neededBy: "2026-11-20",
      today: TODAY,
    });

    expect(decision.approvalChain.map((step) => step.queue)).toEqual([
      "research_admin",
      "sponsored_programs",
      "cfo_office",
    ]);
    expect(decision.flags).toContain("high_value");
    expect(decision.flags).toContain("multi_level");
  });

  it("expedites high-priority requests", () => {
    const decision = routeRequest({
      fundingSource: "department",
      amount: 1000,
      priority: "high",
      neededBy: "2026-12-20",
      today: TODAY,
    });

    expect(decision.flags).toContain("expedited");
    expect(decision.reasons).toContain("High priority, so the request is expedited.");
  });

  it("expedites requests needed within three days", () => {
    const decision = routeRequest({
      fundingSource: "university",
      amount: 1000,
      priority: "medium",
      neededBy: "2026-10-18",
      today: TODAY,
    });

    expect(decision.flags).toContain("expedited");
  });

  it("calculates calendar days until the requested date", () => {
    expect(daysUntil("2026-10-18", TODAY)).toBe(3);
    expect(daysUntil("2026-10-14", TODAY)).toBe(-1);
  });

  it("returns the next approval step and null when the chain is complete", () => {
    const decision = routeRequest({
      fundingSource: "department",
      amount: 30000,
      priority: "medium",
      neededBy: "2026-11-20",
      today: TODAY,
    });

    expect(getNextApprovalStep(decision, 0)).toEqual(decision.approvalChain[0]);
    expect(getNextApprovalStep(decision, 1)).toEqual(decision.approvalChain[1]);
    expect(getNextApprovalStep(decision, decision.approvalChain.length)).toBeNull();
  });

  it("reads stored routing decisions and rejects invalid metadata", () => {
    const decision = routeRequest({
      fundingSource: "department",
      amount: 1000,
      priority: "medium",
      neededBy: "2026-11-20",
      today: TODAY,
    });

    expect(readRoutingDecision({ routing: decision })).toEqual(decision);
    expect(readRoutingDecision(null)).toBeNull();
    expect(readRoutingDecision({ routing: { primaryQueue: "department_budget" } })).toBeNull();
  });
});
