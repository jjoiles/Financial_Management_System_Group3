import { describe, expect, it } from "vitest";
import { classifyRequestReadError, filterRequests, getRequestListState, selectVisibleRequests, sortRequests } from "./request-list";
import type { RequestStatus, FundingType } from "./mock-data";

const rows = [
  { id: "FR-2026-A", title: "Lab equipment", email: "ada@howard.edu", department: "Math", status: "Submitted" as RequestStatus, fundingType: "R" as FundingType, amount: 100, submittedAt: "2026-11-18", createdAt: "2026-11-18T08:00:00Z" },
  { id: "FR-2026-B", title: "Lab travel", email: "ben@howard.edu", department: "Physics", status: "Approved" as RequestStatus, fundingType: "Department" as FundingType, amount: 2500, submittedAt: "2026-11-17", createdAt: "2026-11-17T10:00:00Z" },
  { id: "FR-2026-C", title: "Lab supplies", email: "cy@howard.edu", department: "Math", status: "Submitted" as RequestStatus, fundingType: "R" as FundingType, amount: 900, submittedAt: "2026-11-18", createdAt: "2026-11-18T18:00:00Z" },
];

describe("F12 search and filters", () => {
  it.each([
    [" EQUIPMENT ", ["FR-2026-A"]], ["fr-2026-b", ["FR-2026-B"]],
    ["ADA@", ["FR-2026-A"]], ["math", ["FR-2026-A", "FR-2026-C"]],
    ["no match", []], ["   ", rows.map(r => r.id)],
  ])("searches title, number, email and department: %s", (search, ids) => {
    expect(filterRequests(rows, { search }).map(r => r.id)).toEqual(ids);
  });
  it("preserves tracking title/number-only search", () => {
    expect(filterRequests(rows, { search: "math", scope: "tracking" })).toEqual([]);
    expect(filterRequests(rows, { search: "equipment", scope: "tracking" }).map(r => r.id)).toEqual(["FR-2026-A"]);
    expect(filterRequests(rows, { search: "FR-2026-B", status: "Approved", scope: "tracking" }).map(r => r.id)).toEqual(["FR-2026-B"]);
  });
  it.each(["Submitted", "Under Review", "Approved", "Rejected", "Completed"] as const)("filters %s", status => {
    const fixture = { ...rows[0], status };
    expect(filterRequests([fixture, { ...fixture, status: status === "Submitted" ? "Approved" : "Submitted" }], { status })).toEqual([fixture]);
  });
  it.each(["Department", "R", "U"] as const)("filters funding %s", funding => {
    const fixture = { ...rows[0], fundingType: funding };
    expect(filterRequests([fixture, { ...fixture, fundingType: funding === "R" ? "U" : "R" }], { funding })).toEqual([fixture]);
  });
  it("All retains requests and empty filters produce zero matches", () => {
    expect(filterRequests(rows, { status: "All" })).toHaveLength(3);
    expect(filterRequests([], { search: "lab", status: "Submitted", funding: "R" })).toEqual([]);
  });
});

describe("F12 sorting", () => {
  it.each([
    ["newest", ["FR-2026-C", "FR-2026-A", "FR-2026-B"]],
    ["oldest", ["FR-2026-B", "FR-2026-A", "FR-2026-C"]],
    ["amount-desc", ["FR-2026-B", "FR-2026-C", "FR-2026-A"]],
    ["amount-asc", ["FR-2026-A", "FR-2026-C", "FR-2026-B"]],
  ] as const)("orders %s including same-day timestamps", (sort, ids) => {
    expect(sortRequests(rows, sort).map(r => r.id)).toEqual(ids);
    expect(rows.map(r => r.id)).toEqual(["FR-2026-A", "FR-2026-B", "FR-2026-C"]);
  });
  it.each(["newest", "oldest", "amount-desc", "amount-asc"] as const)("composes %s with all three filters", sort => {
    const result = sortRequests(filterRequests(rows, { search: "lab", status: "Submitted", funding: "R" }), sort);
    expect(result.map(r => r.id)).toEqual(sort === "newest" || sort === "amount-desc" ? ["FR-2026-C", "FR-2026-A"] : ["FR-2026-A", "FR-2026-C"]);
  });
  it("uses date fallback, handles missing dates and preserves ties", () => {
    const tied = rows.map(r => ({ ...r, amount: 100 }));
    expect(sortRequests(tied, "amount-asc")).toEqual(tied);
    expect(sortRequests([{ ...rows[0], createdAt: undefined }, { ...rows[1], createdAt: undefined }], "oldest").map(r => r.id)).toEqual(["FR-2026-B", "FR-2026-A"]);
    expect(sortRequests([{ ...rows[0], createdAt: "invalid" }, rows[1]], "newest")[0].id).toBe("FR-2026-B");
  });
});

describe("F12 access handling", () => {
  it.each([
    { code: "42501", message: "permission denied for function is_admin_or_reviewer" },
    { status: 401 }, { status: 403 }, { code: "PGRST301" },
    new Error("permission denied for table financial_requests"),
    { message: "new row violates row-level security policy" },
  ])("classifies authorization failure without pretending the list is empty: %j", error => {
    const issue = classifyRequestReadError(error);
    expect(issue.kind).toBe("access");
    expect(getRequestListState(false, 0, issue)).toBe("restricted");
  });
  it("distinguishes availability, loading, empty, and locally available results", () => {
    const issue = classifyRequestReadError(new Error("Failed to fetch"));
    expect(issue.kind).toBe("unavailable");
    expect(getRequestListState(false, 0, issue)).toBe("unavailable");
    expect(getRequestListState(true, 0, issue)).toBe("loading");
    expect(getRequestListState(false, 0, null)).toBe("empty");
    expect(getRequestListState(false, 1, classifyRequestReadError({ code: "42501" }))).toBe("ready");
  });
  const owned = { userId: "self", prototype: true };
  const foreign = { userId: "other", prototype: true };
  const backend = { userId: "other", prototype: false };
  it("never exposes another user's locally stored requests even on All Requests", () => {
    expect(selectVisibleRequests([owned, foreign, backend], "self", false)).toEqual([owned, backend]);
  });
  it("requires ownership for My Requests and a session for any results", () => {
    expect(selectVisibleRequests([owned, foreign, backend], "self", true)).toEqual([owned]);
    expect(selectVisibleRequests([owned, foreign, backend], undefined, false)).toEqual([]);
  });
});