import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useAppContext } from "@/lib/app-context";
import { useFinancialRequests, type EnrichedRequest } from "@/lib/requests-data";
import StatusBadge from "@/components/StatusBadge";
import RequestDetailDialog from "@/components/RequestDetailDialog";
import financeOpsImage from "@/assets/university-finance-ops.jpg";
import {
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  TrendingUp,
  Loader2,
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
  const { data: requests, loading } = useFinancialRequests();
  const [selected, setSelected] = useState<EnrichedRequest | null>(null);

  const stats = useMemo(() => [
    { label: "Total Requests", value: requests.length, icon: FileText, color: "text-primary" },
    { label: "Pending Review", value: requests.filter((r) => r.status === "Under Review" || r.status === "Submitted").length, icon: Clock, color: "text-warning" },
    { label: "Approved", value: requests.filter((r) => r.status === "Approved" || r.status === "Completed").length, icon: CheckCircle2, color: "text-success" },
    { label: "Rejected", value: requests.filter((r) => r.status === "Rejected").length, icon: XCircle, color: "text-destructive" },
  ], [requests]);

  const totalAmount = requests.reduce((sum, r) => sum + r.amount, 0);
  const pendingRequests = requests.filter((r) => r.status === "Submitted" || r.status === "Under Review");
  const recentRequests = requests.slice(0, 6);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-primary/5">
        <div className="grid gap-6 p-5 lg:grid-cols-[1fr_26rem] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">University finance operations</p>
            <h1 className="mt-2 text-3xl font-bold text-card-foreground sm:text-4xl">
              {role === "leadership" ? "Executive Overview" : role === "admin" ? "Admin Dashboard" : "My Overview"}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Submit, route, review, and measure financial requests across department, research, and university funding streams.
            </p>
          </div>
          <img src={financeOpsImage} alt="University finance team reviewing automated request dashboards" width={1280} height={768} className="hidden h-56 w-full rounded-xl object-cover lg:block" />
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Operational snapshot</h2>
          <p className="mt-1 text-sm text-muted-foreground">Financial request management at a glance</p>
        </div>
        <Link
          to="/submit"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <FileText className="h-4 w-4" />
          New Request
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{stat.label}</span>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </div>
            <p className="mt-2 text-2xl font-bold text-card-foreground">{loading ? "—" : stat.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total Requested Amount</p>
            <p className="text-xl font-bold text-card-foreground">${totalAmount.toLocaleString()}</p>
          </div>
        </div>
      </div>

      <RequestList
        title="Pending Requests"
        subtitle="Awaiting review or decision"
        requests={pendingRequests}
        loading={loading}
        onSelect={setSelected}
        emptyText="No pending requests right now."
      />

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold text-card-foreground">Recent Activity</h3>
          <Link to="/requests" className="flex items-center gap-1 text-xs text-primary hover:underline">
            View all <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : recentRequests.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No requests yet. <Link to="/submit" className="text-primary hover:underline">Submit your first request</Link>.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentRequests.map((req) => (
              <button
                key={req.uuid}
                onClick={() => setSelected(req)}
                className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-accent/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-card-foreground">{req.title}</p>
                  <p className="text-xs text-muted-foreground">{req.id} · {req.department}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="hidden text-sm font-medium text-card-foreground sm:inline">${req.amount.toLocaleString()}</span>
                  <StatusBadge status={req.status} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <RequestDetailDialog request={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function RequestList({
  title,
  subtitle,
  requests,
  loading,
  onSelect,
  emptyText,
}: {
  title: string;
  subtitle: string;
  requests: EnrichedRequest[];
  loading: boolean;
  onSelect: (r: EnrichedRequest) => void;
  emptyText: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : requests.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="divide-y divide-border">
          {requests.map((req) => (
            <button
              key={req.uuid}
              onClick={() => onSelect(req)}
              className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-accent/40"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-card-foreground">{req.title}</p>
                <p className="text-xs text-muted-foreground">{req.id} · {req.department} · {req.fundingType}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="hidden text-sm font-medium text-card-foreground sm:inline">${req.amount.toLocaleString()}</span>
                <StatusBadge status={req.status} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
