import { describe, expect, it } from "vitest";
import {
  calculateAnalyticsSummary,
  getReportingWindowData,
} from "./analytics-utils";

describe("Lab 3 analytics architecture refactor", () => {
  it("calculates the original dashboard KPIs", () => {
    const result = calculateAnalyticsSummary([
      { status: "Submitted", amount: 100 },
      { status: "Under Review", amount: 200 },
      { status: "Approved", amount: 300 },
      { status: "Completed", amount: 400 },
    ]);

    expect(result).toEqual({
      pending: 2,
      completed: 2,
      avgAmount: 250,
      overdue: 1,
      totalRequests: 4,
      approvalRate: 50,
    });
  });

  it("handles an empty request list", () => {
    expect(calculateAnalyticsSummary([])).toEqual({
      pending: 0,
      completed: 0,
      avgAmount: 0,
      overdue: 0,
      totalRequests: 0,
      approvalRate: 0,
    });
  });

  it("preserves rounding behavior", () => {
    const result = calculateAnalyticsSummary([
      { status: "Approved", amount: 100 },
      { status: "Submitted", amount: 101 },
      { status: "Submitted", amount: 101 },
    ]);

    expect(result.avgAmount).toBe(101);
    expect(result.approvalRate).toBe(33);
  });

  it("preserves weekly chart data", () => {
    const data = getReportingWindowData("Week");

    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({
      month: "W1",
      submitted: 6,
      approved: 4,
      rejected: 1,
    });
  });

  it("preserves quarterly chart data", () => {
    const data = getReportingWindowData("Quarter");

    expect(data).toHaveLength(4);
    expect(data[0].month).toBe("Q1");
    expect(data[3].submitted).toBe(62);
  });

  it("returns monthly chart data", () => {
    const data = getReportingWindowData("Month");

    expect(data.length).toBeGreaterThan(0);
  });
});
