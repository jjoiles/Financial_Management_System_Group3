import { describe, expect, it } from "vitest";
import { buildRequestListCsv } from "./csv-export";
import { prepareRequestExport, requestExportBlockReason, type RequestExportContext } from "./request-export";
import { classifyRequestReadError, filterRequests, sortRequests } from "./request-list";

const context: RequestExportContext = { userId: "self", loading: false, needsMfa: false, readIssue: null };
const row = {
  id: "FR-2026-A", title: 'Lab, "equipment"\nGrant', requester: "Ada", email: "ada@howard.edu",
  department: "Math", amount: 100.25, fundingType: "R" as const, status: "Submitted" as const,
  submittedAt: "2026-11-18", createdAt: "2026-11-18T12:30:00Z", prototype: false, userId: "self",
};

describe("F23 request export", () => {
  it("includes the approved fields and escaped values without unrelated private fields", () => {
    const csv = buildRequestListCsv([{ ...row, description: "not exported", access_token: "not exported either" } as typeof row]);
    expect(csv).toContain('"Request ID","Title","Requester","Department","Amount","Funding Source","Status","Creation Date","Storage"');
    expect(csv).toContain('"Lab, ""equipment""\nGrant"');
    expect(csv).toContain('"100.25","R","Submitted","2026-11-18T12:30:00Z","Backend"');
    expect(csv).not.toContain("not exported");
  });
  it("preserves Unicode and neutralizes formula injection in titles", () => {
    expect(buildRequestListCsv([{ ...row, title: "Équipement 数学" }])).toContain("Équipement 数学");
    expect(buildRequestListCsv([{ ...row, title: "=HYPERLINK(1)" }])).toContain('"\'=HYPERLINK(1)"');
  });
  it("labels prototype storage and falls back to the submission date", () => {
    expect(buildRequestListCsv([{ ...row, prototype: true, createdAt: undefined }])).toContain('"2026-11-18","Prototype - local only"');
  });
  it("uses CRLF and preserves passed row order", () => {
    const file = prepareRequestExport([{ ...row, id: "second" }, { ...row, id: "first" }], context, new Date("2026-11-18T05:00:00Z"));
    expect(file.csv.split("\r\n").slice(1).map(line => line.split(",")[0])).toEqual(['"second"', '"first"']);
    expect(file.filename).toBe("financial-requests-2026-11-18.csv");
    expect(file.count).toBe(2);
  });
  it.each(["newest", "oldest", "amount-desc", "amount-asc"] as const)("exports the same filtered F12 rows in %s order", sort => {
    const rows = [row, { ...row, id: "FR-2026-C", amount: 900, createdAt: "2026-11-19T10:00:00Z" }, { ...row, id: "hidden", department: "Physics" }];
    const visible = sortRequests(filterRequests(rows, { search: "math", status: "Submitted", funding: "R" }), sort);
    const file = prepareRequestExport(visible, context);
    const expected = sort === "newest" || sort === "amount-desc" ? ["FR-2026-C", "FR-2026-A"] : ["FR-2026-A", "FR-2026-C"];
    expect(file.csv.split("\r\n").slice(1).map(line => line.split(",")[0])).toEqual(expected.map(id => `"${id}"`));
    expect(file.csv).not.toContain("hidden");
  });
  it("retains Pending then Decided section order without re-sorting the export", () => {
    const sorted = sortRequests([row, { ...row, id: "decided", status: "Approved" as const, amount: 5000 }], "amount-desc");
    const visible = [...sorted.filter(r => r.status === "Submitted"), ...sorted.filter(r => r.status === "Approved")];
    expect(prepareRequestExport(visible, context).csv.split("\r\n").slice(1).map(line => line.split(",")[0])).toEqual(['"FR-2026-A"', '"decided"']);
  });
  it("returns headers for pure empty serialization but blocks an empty download", () => {
    expect(buildRequestListCsv([]).split("\r\n")).toHaveLength(1);
    expect(() => prepareRequestExport([], context)).toThrow("No matching requests");
  });
  it.each([{ code: "42501" }, { status: 403 }, { status: 401 }])("blocks denied reads even when local rows are present: %j", error => {
    expect(() => prepareRequestExport([{ ...row, prototype: true }], { ...context, readIssue: classifyRequestReadError(error) })).toThrow("Access restricted");
  });
  it("blocks unavailable data, loading, sign-out, and incomplete verification", () => {
    for (const blocked of [{ ...context, readIssue: classifyRequestReadError(new Error("Failed to fetch")) }, { ...context, loading: true }, { ...context, userId: undefined }, { ...context, needsMfa: true }]) {
      expect(requestExportBlockReason(blocked, 1)).not.toBeNull();
      expect(() => prepareRequestExport([row], blocked)).toThrow();
    }
  });
  it("rejects another user's local row rather than silently exporting a subset", () => {
    expect(() => prepareRequestExport([{ ...row, prototype: true, userId: "other" }], context)).toThrow("Access restricted");
  });
  it("reports malformed numeric data instead of creating an invalid file", () => {
    expect(() => prepareRequestExport([{ ...row, amount: Infinity }], context)).toThrow(RangeError);
  });
});