
import { describe, expect, it } from "vitest";
import {
  buildFinancialReportCsv,
  escapeCsvCell,
  type ExportableRequest,
} from "./csv-export";

const request: ExportableRequest = {
  id: "FR-2026-0001",
  requester: "Student",
  department: "Engineering",
  fundingType: "Department",
  amount: 125.5,
  status: "Submitted",
  updatedAt: "2026-10-26",
};

describe("F23 CSV trust boundary", () => {
  it.each([
    "=1+1",
    "+SUM(A1:A2)",
    "-2+3",
    "@SUM(A1:A2)",
    "  =1+1",
    "\t=1+1",
    "\r\n=1+1",
    "\uFEFF=1+1",
    "\u200B=1+1",
  ])("neutralizes dangerous text %j", (value) => {
    expect(escapeCsvCell(value)).toBe(`"'${value}"`);
  });

  it("keeps legitimate negative numeric values", () => {
    expect(escapeCsvCell(-42)).toBe('"-42"');
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(escapeCsvCell('A,"B"\nC')).toBe('"A,""B""\nC"');
  });

  it("rejects NaN and Infinity", () => {
    expect(() => escapeCsvCell(NaN)).toThrow(RangeError);
    expect(() => escapeCsvCell(Infinity)).toThrow(RangeError);
  });

  it("rejects invalid runtime cell types", () => {
    expect(() =>
      escapeCsvCell(null as unknown as string),
    ).toThrow(TypeError);
  });

  it("preserves FinReq's seven-column report and CRLF row endings", () => {
    const result = buildFinancialReportCsv([request]);

    expect(result.split("\r\n")).toHaveLength(2);

    expect(result).toContain(
      '"Request ID","Requester","Department","Funding Type","Amount","Status","Updated At"',
    );

    expect(result).toContain(
      '"FR-2026-0001","Student","Engineering","Department","125.5","Submitted","2026-10-26"',
    );
  });

  it("does not serialize fields outside the approved report", () => {
    const requestWithExtraField = {
      ...request,
      secret: "private",
    };
    const result = buildFinancialReportCsv([
      requestWithExtraField,
    ]);

    expect(result).not.toContain("private");
  });

  it("neutralizes malicious requester names within full reports", () => {
    const result = buildFinancialReportCsv([
      { ...request, requester: "=HYPERLINK(1)" },
    ]);

    expect(result).toContain("\"'=HYPERLINK(1)\"");
  });

  it("returns headers for empty arrays", () => {
    const result = buildFinancialReportCsv([]);

    expect(result.split("\r\n")).toHaveLength(1);
  });

  it("rejects invalid requests and malformed amounts", () => {
    expect(() =>
      buildFinancialReportCsv(
        null as unknown as ExportableRequest[],
      ),
    ).toThrow(TypeError);

    expect(() =>
      buildFinancialReportCsv([
        null as unknown as ExportableRequest,
      ]),
    ).toThrow(TypeError);

    expect(() =>
      buildFinancialReportCsv([
        { ...request, amount: Infinity },
      ]),
    ).toThrow(RangeError);
  });
});
