import { createFileRoute } from "@tanstack/react-router";
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
import { mockRequests, monthlyData, fundingDistribution, turnaroundData } from "@/lib/mock-data";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
  head: () => ({
    meta: [
      { title: "Analytics — FinReq" },
      { name: "description", content: "Financial request analytics and insights dashboard." },
    ],
  }),
});

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#a855f7", "#ef4444"];

function AnalyticsPage() {
  const pending = mockRequests.filter((r) => r.status === "Submitted" || r.status === "Under Review").length;
  const completed = mockRequests.filter((r) => r.status === "Completed" || r.status === "Approved").length;
  const avgAmount = Math.round(mockRequests.reduce((s, r) => s + r.amount, 0) / mockRequests.length);

  const kpis = [
    { label: "Avg. Turnaround", value: "4.8 days" },
    { label: "Avg. Request", value: `$${avgAmount.toLocaleString()}` },
    { label: "Pending", value: String(pending) },
    { label: "Completed", value: String(completed) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">Insights across all financial requests</p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-2xl font-bold font-[family-name:var(--font-display)] text-card-foreground">{k.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Monthly Requests */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground mb-4">Monthly Requests</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyData}>
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

        {/* Funding Distribution */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground mb-4">Funding Distribution</h3>
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

      {/* Turnaround by Department */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground mb-4">Avg. Approval Turnaround by Department (days)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={turnaroundData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
            <YAxis dataKey="department" type="category" tick={{ fontSize: 11 }} width={90} stroke="var(--color-muted-foreground)" />
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
