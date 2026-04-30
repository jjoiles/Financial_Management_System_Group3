import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useFinancialRequests, type EnrichedRequest } from "@/lib/requests-data";
import { useAuth } from "@/lib/auth-context";
import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";
import RequestDetailDialog from "@/components/RequestDetailDialog";
import { FileText, Loader2, Plus } from "lucide-react";

export const Route = createFileRoute("/tracking")({
  component: TrackingPage,
  head: () => ({
    meta: [
      { title: "My Requests — FinReq" },
      { name: "description", content: "Track status of your financial requests." },
    ],
  }),
});

function TrackingPage() {
  const auth = useAuth();
  const { data, loading } = useFinancialRequests();
  const [selected, setSelected] = useState<EnrichedRequest | null>(null);

  const myRequests = useMemo(
    () => data.filter((r) => !auth.user?.email || r.email === auth.user.email || r.prototype),
    [data, auth.user?.email],
  );

  const pending = myRequests.filter((r) => r.status === "Submitted" || r.status === "Under Review");
  const submitted = myRequests.filter((r) => r.status === "Approved" || r.status === "Rejected" || r.status === "Completed");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track the progress of your submissions</p>
        </div>
        <Link to="/submit" className="inline-flex items-center gap-2 self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90">
          <Plus className="h-4 w-4" /> New Request
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : myRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-20 shadow-sm">
          <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">You haven't submitted any requests yet.</p>
          <Link to="/submit" className="mt-3 text-sm font-medium text-primary hover:underline">Create your first request</Link>
        </div>
      ) : (
        <div className="space-y-8">
          <Group title="Pending Requests" subtitle="Awaiting review or decision" requests={pending} onSelect={setSelected} emptyText="No pending requests." />
          <Group title="Submitted Requests" subtitle="Approved, denied, or completed" requests={submitted} onSelect={setSelected} emptyText="No completed requests yet." />
        </div>
      )}

      <RequestDetailDialog request={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function Group({ title, subtitle, requests, onSelect, emptyText }: { title: string; subtitle: string; requests: EnrichedRequest[]; onSelect: (r: EnrichedRequest) => void; emptyText: string }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {requests.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card/50 px-5 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-4">
          {requests.map((req) => (
            <button key={req.uuid} onClick={() => onSelect(req)} className="block w-full space-y-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-card-foreground">{req.title}</h3>
                    <StatusBadge status={req.status} />
                    {req.prototype && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Prototype</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{req.id} · ${req.amount.toLocaleString()} · {req.fundingType} Fund</p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-muted-foreground">Submitted</p>
                  <p className="font-medium text-card-foreground">{req.submittedAt}</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <WorkflowTracker status={req.status} />
              </div>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{req.description}</p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
