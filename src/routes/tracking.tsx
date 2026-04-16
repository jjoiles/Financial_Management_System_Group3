import { createFileRoute } from "@tanstack/react-router";
import { mockRequests } from "@/lib/mock-data";
import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";
import { FileText } from "lucide-react";

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
  // Simulating "my" requests
  const myRequests = mockRequests.filter((r) => r.requester === "Dr. Sarah Chen");

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">My Requests</h1>
        <p className="text-sm text-muted-foreground mt-1">Track the progress of your submissions</p>
      </div>

      {myRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-border bg-card">
          <FileText className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No requests found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {myRequests.map((req) => (
            <div key={req.id} className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="text-base font-semibold font-[family-name:var(--font-display)] text-card-foreground">{req.title}</h3>
                    <StatusBadge status={req.status} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{req.id} · ${req.amount.toLocaleString()} · {req.fundingType} Fund</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Submitted</p>
                  <p className="text-xs font-medium text-card-foreground">{req.submittedAt}</p>
                </div>
              </div>

              <WorkflowTracker status={req.status} />

              <p className="text-xs text-muted-foreground leading-relaxed">{req.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
