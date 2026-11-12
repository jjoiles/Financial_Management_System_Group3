import { monthlyData } from "./mock-data";

export type ReportingWindow = "Week" | "Month" | "Quarter";

export type AnalyticsRequest = {
  status: string;
  amount: number;
};

export type AnalyticsSummary = {
  pending: number;
  completed: number;
  avgAmount: number;
  overdue: number;
  totalRequests: number;
  approvalRate: number;
};

export type ChartDataPoint = {
  month: string;
  submitted: number;
  approved: number;
  rejected: number;
};

/**
 * Calculate financial dashboard metrics independently
 * of React components and rendering logic.
 */
export function calculateAnalyticsSummary(
  requests: readonly AnalyticsRequest[],
): AnalyticsSummary {
  const pending = requests.filter(
    (r) => r.status === "Submitted" || r.status === "Under Review",
  ).length;

  const completed = requests.filter(
    (r) => r.status === "Completed" || r.status === "Approved",
  ).length;

  const avgAmount = requests.length
    ? Math.round(
        requests.reduce((sum, r) => sum + r.amount, 0) / requests.length,
      )
    : 0;

  const overdue = requests.filter(
    (r) => r.status === "Under Review",
  ).length;

  return {
    pending,
    completed,
    avgAmount,
    overdue,
    totalRequests: requests.length,
    approvalRate: requests.length
      ? Math.round((completed / requests.length) * 100)
      : 0,
  };
}

/**
 * Return the original dashboard chart data for
 * the selected reporting window.
 */
export function getReportingWindowData(
  windowKey: ReportingWindow,
): ChartDataPoint[] {
  if (windowKey === "Week") {
    return [
      { month: "W1", submitted: 6, approved: 4, rejected: 1 },
      { month: "W2", submitted: 8, approved: 6, rejected: 2 },
      { month: "W3", submitted: 10, approved: 7, rejected: 3 },
      { month: "W4", submitted: 9, approved: 8, rejected: 2 },
    ];
  }

  if (windowKey === "Quarter") {
    return [
      { month: "Q1", submitted: 44, approved: 34, rejected: 6 },
      { month: "Q2", submitted: 51, approved: 38, rejected: 8 },
      { month: "Q3", submitted: 58, approved: 42, rejected: 10 },
      { month: "Q4", submitted: 62, approved: 46, rejected: 11 },
    ];
  }

  return [...monthlyData];
}
