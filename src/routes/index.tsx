import { createFileRoute, Link } from "@tanstack/react-router";
import { mockRequests } from "@/lib/mock-data";
import { useAppContext } from "@/lib/app-context";
import StatusBadge from "@/components/StatusBadge";
import {
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  TrendingUp,
} from "lucide-react";

export const Route = createFileRoute("/")({
  component: OverviewPage,
  head: () => ({
    meta: [
      { title: "Overview — FinReq" },
      { name: "description", content: "Financial request management overview and recent activity." },
    ],
  }),
});

function OverviewPage() {
  const { role } = useAppContext();

  const stats = [
    { label: "Total Requests", value: mockRequests.length, icon: FileText, color: "text-primary" },
    { label: "Pending Review", value: mockRequests.filter((r) => r.status === "Under Review" || r.status === "Submitted").length, icon: Clock, color: "text-warning" },
    { label: "Approved", value: mockRequests.filter((r) => r.status === "Approved").length, icon: CheckCircle2, color: "text-success" },
    { label: "Rejected", value: mockRequests.filter((r) => r.status === "Rejected").length, icon: XCircle, color: "text-destructive" },
  ];

  const totalAmount = mockRequests.reduce((sum, r) => sum + r.amount, 0);
  const recentRequests = [...mockRequests].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">
            {role === "leadership" ? "Executive Overview" : role === "admin" ? "Admin Dashboard" : "My Overview"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Financial request management at a glance
          </p>
        </div>
        {(role === "requester" || role === "admin") && (
          <Link
            to="/submit"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <FileText className="h-4 w-4" />
            New Request
          </Link>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{stat.label}</span>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </div>
            <p className="mt-2 text-2xl font-bold font-[family-name:var(--font-display)] text-card-foreground">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Total Amount Card */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total Requested Amount</p>
            <p className="text-xl font-bold font-[family-name:var(--font-display)] text-card-foreground">
              ${totalAmount.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Recent Requests */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold font-[family-name:var(--font-display)] text-card-foreground">
            Recent Activity
          </h3>
          {role === "admin" && (
            <Link to="/requests" className="flex items-center gap-1 text-xs text-primary hover:underline">
              View all <ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>
        <div className="divide-y divide-border">
          {recentRequests.map((req) => (
            <div key={req.id} className="flex items-center justify-between px-5 py-3.5">
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-sm font-medium text-card-foreground">{req.title}</p>
                  <p className="text-xs text-muted-foreground">{req.id} · {req.requester}</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-card-foreground">${req.amount.toLocaleString()}</span>
                <StatusBadge status={req.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
