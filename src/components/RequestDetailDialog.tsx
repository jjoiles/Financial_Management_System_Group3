import { X, Paperclip, Calendar, Building2, DollarSign, AlertCircle, Mail, Tag } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";
import type { EnrichedRequest } from "@/lib/requests-data";
import { useRequestActivity } from "@/lib/activity-data";

export default function RequestDetailDialog({ request, onClose }: { request: EnrichedRequest | null; onClose: () => void }) {
  if (!request) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-card px-6 py-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-primary">{request.id}</p>
            <h2 className="mt-1 truncate text-lg font-semibold text-card-foreground">{request.title}</h2>
            <div className="mt-2 flex items-center gap-2">
              <StatusBadge status={request.status} />
              {request.prototype && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Prototype</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <WorkflowTracker status={request.status} />

          <div className="grid gap-3 sm:grid-cols-2">
            <DetailRow icon={Mail} label="Requester" value={request.email} />
            <DetailRow icon={Building2} label="Department" value={request.department} />
            <DetailRow icon={Tag} label="Funding Source" value={`${request.fundingType} Fund`} />
            <DetailRow icon={DollarSign} label="Amount" value={`$${request.amount.toLocaleString()}`} />
            <DetailRow icon={AlertCircle} label="Priority" value={request.priority} />
            <DetailRow icon={Calendar} label="Needed By" value={request.neededBy} />
            <DetailRow icon={Calendar} label="Submitted" value={request.submittedAt} />
            {request.routedTo && <DetailRow icon={Paperclip} label="Routed To" value={request.routedTo} />}
          </div>

          {request.routing && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approval Chain</p>
              <ol className="space-y-2 rounded-lg border border-border bg-background p-4">
                {request.routing.approvalChain.map((step) => (
                  <li key={step.queue} className="text-sm text-foreground">
                    <span className="font-medium">{step.step}. {step.label}</span>
                    <span className="block text-xs text-muted-foreground">{step.reason}</span>
                  </li>
                ))}
                {request.routing.flags.includes("expedited") && (
                  <li className="text-xs font-semibold text-warning">Expedited</li>
                )}
              </ol>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-sm leading-6 text-foreground">
              {request.description}
            </p>
          </div>

          {!request.prototype && <ActivityLog requestId={request.uuid} />}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className="mt-1 break-words text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function ActivityLog({ requestId }: { requestId: string }) {
  const { events, loading, error } = useRequestActivity(requestId);
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</p>
      <div className="rounded-lg border border-border bg-background p-4">
        {loading && <p className="text-xs text-muted-foreground">Loading activity…</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!loading && !error && events.length === 0 && <p className="text-xs text-muted-foreground">No activity recorded yet.</p>}
        <ol className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0">
                <p className="text-foreground">{event.message}</p>
                <p className="text-[11px] text-muted-foreground">{new Date(event.createdAt).toLocaleString()} · {event.eventType.replace(/_/g, " ")}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
