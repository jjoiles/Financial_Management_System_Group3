import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { mockRequests, type FundingType, type RequestStatus } from "@/lib/mock-data";
import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";
import { Search, Filter, Paperclip, X } from "lucide-react";

export const Route = createFileRoute("/requests")({
  component: RequestsPage,
  head: () => ({
    meta: [
      { title: "All Requests — FinReq" },
      { name: "description", content: "View and manage all financial requests." },
    ],
  }),
});

function RequestsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RequestStatus | "">("");
  const [fundingFilter, setFundingFilter] = useState<FundingType | "">("");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = mockRequests.filter((r) => {
    if (search && !r.title.toLowerCase().includes(search.toLowerCase()) && !r.id.toLowerCase().includes(search.toLowerCase()) && !r.requester.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (fundingFilter && r.fundingType !== fundingFilter) return false;
    return true;
  });

  const selectedRequest = mockRequests.find((r) => r.id === selected);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">All Requests</h1>
          <p className="text-sm text-muted-foreground mt-1">{filtered.length} requests found</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Search by ID, title, or requester…"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as RequestStatus | "")}
            className="rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Statuses</option>
            <option value="Submitted">Submitted</option>
            <option value="Under Review">Under Review</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
            <option value="Completed">Completed</option>
          </select>
          <select
            value={fundingFilter}
            onChange={(e) => setFundingFilter(e.target.value as FundingType | "")}
            className="rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Funding</option>
            <option value="Department">Department</option>
            <option value="R">Research (R)</option>
            <option value="U">University (U)</option>
          </select>
        </div>
      </div>

      <div className="flex gap-4">
        {/* Table */}
        <div className={`rounded-xl border border-border bg-card overflow-hidden ${selected ? "flex-1" : "w-full"}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Requester</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id === selected ? null : r.id)}
                  className={`cursor-pointer transition-colors hover:bg-accent/50 ${selected === r.id ? "bg-primary/5" : ""}`}
                >
                  <td className="px-4 py-3 font-mono text-xs text-primary">{r.id}</td>
                  <td className="px-4 py-3 font-medium text-card-foreground">{r.title}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.requester}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.fundingType}</td>
                  <td className="px-4 py-3 text-right font-medium text-card-foreground">${r.amount.toLocaleString()}</td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{r.submittedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail Panel */}
        {selectedRequest && (
          <div className="w-96 shrink-0 rounded-xl border border-border bg-card p-5 space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-mono text-primary">{selectedRequest.id}</p>
                <h3 className="text-base font-semibold font-[family-name:var(--font-display)] text-card-foreground mt-1">{selectedRequest.title}</h3>
              </div>
              <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <WorkflowTracker status={selectedRequest.status} />

            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Requester</span>
                <span className="text-card-foreground font-medium">{selectedRequest.requester}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Department</span>
                <span className="text-card-foreground">{selectedRequest.department}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Funding Type</span>
                <span className="text-card-foreground">{selectedRequest.fundingType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="text-card-foreground font-semibold">${selectedRequest.amount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Priority</span>
                <span className="text-card-foreground">{selectedRequest.priority}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Submitted</span>
                <span className="text-card-foreground">{selectedRequest.submittedAt}</span>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">Description</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{selectedRequest.description}</p>
            </div>

            {selectedRequest.attachments > 0 && (
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{selectedRequest.attachments} attachment(s)</span>
              </div>
            )}

            <div className="flex gap-2">
              <button className="flex-1 rounded-md bg-success px-3 py-2 text-xs font-medium text-success-foreground hover:opacity-90">
                Approve
              </button>
              <button className="flex-1 rounded-md bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground hover:opacity-90">
                Reject
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
