import { describe, expect, it } from "vitest";
import { daysUntil, getNextApprovalStep, readRoutingDecision, routeRequest } from "./engine";
import type { FundingSource, Priority } from "@/lib/validation/request-schema";

// F8.4: Verify Routing Logic (#272). Cases come from the How to Test table in
// docs/F8_Intelligent_Branching_Routing.md.

const TODAY = new Date("2026-11-23T12:00:00");
const FAR_DATE = "2026-12-31";

const route = (
  fundingSource: FundingSource,
  amount: number,
  priority: Priority = "medium",
  neededBy = FAR_DATE,
) => routeRequest({ fundingSource, amount, priority, neededBy, today: TODAY });

const chain = (decision: ReturnType<typeof routeRequest>) =>
  decision.approvalChain.map((step) => step.label);

describe("F8.4.1 (#320): base queue for each funding source", () => {
  it.each([
    ["department", "Department Budget Reviewer"],
    ["research", "Research Administration"],
    ["university", "Provost Finance Office"],
  ] as const)("%s funding starts at %s", (funding, label) => {
    const decision = route(funding, 500);
    expect(decision.primaryLabel).toBe(label);
    expect(chain(decision)).toEqual([label]);
    expect(decision.flags).toEqual([]);
  });

  it("stores the rules version and a reason for every step", () => {
    const decision = route("department", 30_000);
    expect(decision.rulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(decision.approvalChain.every((step) => step.reason.length > 0)).toBe(true);
    expect(decision.approvalChain.map((step) => step.step)).toEqual([1, 2, 3]);
  });
});

describe("F8.4.2 (#321): amount tier thresholds", () => {
  // Rows from the doc table.
  it.each([
    ["department", 500, ["Department Budget Reviewer"]],
    ["department", 5_000, ["Department Budget Reviewer", "Dean's Office"]],
    ["department", 30_000, ["Department Budget Reviewer", "Dean's Office", "Office of the CFO"]],
    ["research", 10_000, ["Research Administration"]],
    [
      "research",
      30_000,
      ["Research Administration", "Office of Sponsored Programs", "Office of the CFO"],
    ],
  ] as const)("%s $%d routes to the documented chain", (funding, amount, expected) => {
    expect(chain(route(funding, amount))).toEqual(expected);
  });

  it("treats thresholds as inclusive and stops one cent below", () => {
    expect(chain(route("department", 4_999.99))).toEqual(["Department Budget Reviewer"]);
    expect(chain(route("department", 5_000))).toContain("Dean's Office");
    expect(chain(route("department", 24_999.99))).not.toContain("Office of the CFO");
    expect(chain(route("department", 25_000))).toContain("Office of the CFO");
    expect(chain(route("research", 24_999.99))).toEqual(["Research Administration"]);
  });

  it("never sends research requests to the Dean's Office", () => {
    expect(chain(route("research", 100_000))).not.toContain("Dean's Office");
  });

  it("flags high value only when the CFO is in the chain", () => {
    expect(route("department", 30_000).flags).toEqual(["high_value", "multi_level"]);
    expect(route("department", 5_000).flags).toEqual(["multi_level"]);
  });
});

describe("F8.4.3 (#322): expedited flag for high priority and near due dates", () => {
  it("University $6,000 High routes Provost then Dean, expedited (doc table row)", () => {
    const decision = route("university", 6_000, "high");
    expect(chain(decision)).toEqual(["Provost Finance Office", "Dean's Office"]);
    expect(decision.flags).toContain("expedited");
  });

  it("Medium priority needed in 2 days is expedited", () => {
    const decision = route("department", 500, "medium", "2026-11-25");
    expect(daysUntil("2026-11-25", TODAY)).toBe(2);
    expect(decision.flags).toContain("expedited");
    expect(decision.reasons.join(" ")).toMatch(/Needed within 3 days/);
  });

  it("uses an inclusive 3-day window", () => {
    expect(route("department", 500, "low", "2026-11-26").flags).toContain("expedited");
    expect(route("department", 500, "low", "2026-11-27").flags).not.toContain("expedited");
  });

  it("does not add the expedited flag twice for high priority due soon", () => {
    const flags = route("department", 500, "high", "2026-11-24").flags;
    expect(flags.filter((flag) => flag === "expedited")).toHaveLength(1);
  });
});

describe("F8 helpers", () => {
  it("getNextApprovalStep walks the chain and ends with null", () => {
    const decision = route("department", 30_000);
    expect(getNextApprovalStep(decision, 0)?.label).toBe("Department Budget Reviewer");
    expect(getNextApprovalStep(decision, 2)?.label).toBe("Office of the CFO");
    expect(getNextApprovalStep(decision, 3)).toBeNull();
  });

  it("readRoutingDecision returns null for pre-F8 metadata", () => {
    expect(readRoutingDecision(null)).toBeNull();
    expect(readRoutingDecision({ routing: { approvalChain: "bad" } })).toBeNull();
    const decision = route("research", 30_000);
    expect(readRoutingDecision({ routing: decision })).toEqual(decision);
  });
});
