import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  ChartDataPoint,
  ReportingWindow,
} from "@/lib/analytics-utils";

type FundingDistributionPoint = {
  name: string;
  value: number;
};

type TurnaroundPoint = {
  department: string;
  days: number;
};

interface AnalyticsVisualizationsProps {
  windowKey: ReportingWindow;
  timeWindowData: ChartDataPoint[];
  fundingDistribution: FundingDistributionPoint[];
  turnaroundData: TurnaroundPoint[];
}

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

const tooltipContentStyle = {
  backgroundColor: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  fontSize: "12px",
};

export default function AnalyticsVisualizations({
  windowKey,
  timeWindowData,
  fundingDistribution,
  turnaroundData,
}: AnalyticsVisualizationsProps) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground">
            {windowKey} Requests
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={timeWindowData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
              />
              <Tooltip contentStyle={tooltipContentStyle} />
              <Bar
                dataKey="submitted"
                fill={CHART_COLORS[0]}
                radius={[4, 4, 0, 0]}
                name="Submitted"
              />
              <Bar
                dataKey="approved"
                fill={CHART_COLORS[1]}
                radius={[4, 4, 0, 0]}
                name="Approved"
              />
              <Bar
                dataKey="rejected"
                fill={CHART_COLORS[4]}
                radius={[4, 4, 0, 0]}
                name="Rejected"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground">
            Funding Distribution
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={fundingDistribution}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={3}
                dataKey="value"
                nameKey="name"
              >
                {fundingDistribution.map((_, index) => (
                  <Cell key={index} fill={CHART_COLORS[index]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipContentStyle} />
              <Legend
                formatter={(value: string) => (
                  <span style={{ fontSize: "11px" }}>{value}</span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground">
          Avg. Approval Turnaround by Department (days)
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={turnaroundData} layout="vertical">
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-border)"
            />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              stroke="var(--color-muted-foreground)"
            />
            <YAxis
              dataKey="department"
              type="category"
              tick={{ fontSize: 11 }}
              width={90}
              stroke="var(--color-muted-foreground)"
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar
              dataKey="days"
              fill={CHART_COLORS[0]}
              radius={[0, 4, 4, 0]}
              name="Days"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
