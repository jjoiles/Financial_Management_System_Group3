import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  ArrowUpRight,
  Download,
  Filter,
  FolderKanban,
  Gauge,
  TrendingUp,
} from "lucide-react";
import { mockRequests, monthlyData, fundingDistribution, turnaroundData } from "@/lib/mock-data";
import { useFinancialRequests } from "@/lib/requests-data";

// F17 requirement: real-time reporting dashboard route for "Real-Time Reporting Templates".
export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
  head: () => ({
    meta: [
      { title: "Analytics — FinReq" },
      { name: "description", content: "Financial request analytics and insights dashboard." },
    ],
  }),
});

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

type WindowKey = "Week" | "Month" | "Quarter";

function AnalyticsPage() {
  // F17 requirement: data source selection for analytics page with fallback mock dataset.
  const { data: requests } = useFinancialRequests();
  const sourceRequests = requests.length ? requests : mockRequests;
  const [windowKey, setWindowKey] = useState<WindowKey>("Month");

  // F17 requirement: KPI aggregation for pending, completed, averages, and approval rate.
  const summary = useMemo(() => {
    const pending = sourceRequests.filter(
      (r) => r.status === "Submitted" || r.status === "Under Review"
    ).length;
    const completed = sourceRequests.filter(
      (r) => r.status === "Completed" || r.status === "Approved"
    ).length;
    const avgAmount = sourceRequests.length
      ? Math.round(
          sourceRequests.reduce((sum, r) => sum + r.amount, 0) / sourceRequests.length
        )
      : 0;
    const overdue = sourceRequests.filter((r) => r.status === "Under Review").length;

    return {
      pending,
      completed,
      avgAmount,
      overdue,
      totalRequests: sourceRequests.length,
      approvalRate: sourceRequests.length
        ? Math.round(
            (sourceRequests.filter((r) => r.status === "Approved" || r.status === "Completed").length /
              sourceRequests.length) *
              100
          )
        : 0,
    };
  }, [sourceRequests]);

  // F17 requirement: reporting-window chart data for Week/Month/Quarter views.
  const timeWindowData = useMemo<Array<{ month: string; submitted: number; approved: number; rejected: number }>>(() => {
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
  }, [windowKey]);

  const kpis = [
    { label: "Avg. Turnaround", value: "4.8 days" },
    { label: "Avg. Request", value: `$${summary.avgAmount.toLocaleString()}` },
    { label: "Pending", value: String(summary.pending) },
    { label: "Completed", value: String(summary.completed) },
  ];

  const templates = [
    {
      title: "Operational Snapshot",
      description: `${summary.totalRequests} requests tracked across active review queues`,
      icon: Gauge,
      trend: "+12.4% vs prior period",
    },
    {
      title: "Funding Mix",
      description: `${summary.approvalRate}% approval rate after routing and validation`,
      icon: FolderKanban,
      trend: "3 funding categories managed",
    },
    {
      title: "SLA Watchlist",
      description: `${summary.overdue} items require intervention or escalation`,
      icon: TrendingUp,
      trend: "2 overdue approvals flagged",
    },
  ];

  // F17 requirement: export feature for generating CSV analytics report.
  const exportReport = () => {
    const rows = [
      ["Request ID", "Requester", "Department", "Funding Type", "Amount", "Status", "Updated At"],
      ...sourceRequests.map((request) => [
        request.id,
        request.requester,
        request.department,
        request.fundingType,
        String(request.amount),
        request.status,
        request.updatedAt,
      ]),
    ];

    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `financial-report-${windowKey.toLowerCase()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">
            Real-Time Reporting Templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Insights across all financial requests and approval workflows
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2 py-1.5 text-sm text-muted-foreground">
            <Filter className="h-4 w-4" />
            <select
              aria-label="Select reporting window"
              value={windowKey}
              onChange={(event) => setWindowKey(event.target.value as WindowKey)}
              className="bg-transparent pr-1 text-sm text-foreground outline-none"
            >
              <option value="Week">Week</option>
              <option value="Month">Month</option>
              <option value="Quarter">Quarter</option>
            </select>
          </div>
          <button
            type="button"
            onClick={exportReport}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-2xl font-bold font-[family-name:var(--font-display)] text-card-foreground">
              {k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {templates.map(({ title, description, icon: Icon, trend }) => (
          <div key={title} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-card-foreground">{title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-primary">{trend}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground">
            {windowKey} Requests
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={timeWindowData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Bar dataKey="submitted" fill={COLORS[0]} radius={[4, 4, 0, 0]} name="Submitted" />
              <Bar dataKey="approved" fill={COLORS[1]} radius={[4, 4, 0, 0]} name="Approved" />
              <Bar dataKey="rejected" fill={COLORS[4]} radius={[4, 4, 0, 0]} name="Rejected" />
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
                {fundingDistribution.map((_, i) => (
                  <Cell key={i} fill={COLORS[i]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Legend
                formatter={(value: string) => <span style={{ fontSize: "11px" }}>{value}</span>}
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
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
            <YAxis
              dataKey="department"
              type="category"
              tick={{ fontSize: 11 }}
              width={90}
              stroke="var(--color-muted-foreground)"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
            />
            <Bar dataKey="days" fill={COLORS[0]} radius={[0, 4, 4, 0]} name="Days" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
