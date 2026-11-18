import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFinancialRequests, type EnrichedRequest } from "@/lib/requests-data";
import { useAuth } from "@/lib/auth-context";
import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";
import RequestDetailDialog from "@/components/RequestDetailDialog";
import RequestSearchBar from "@/components/tracking/RequestSearchBar";
import StatusFilterChips, { type StatusFilter } from "@/components/tracking/StatusFilterChips";
import RequestCountSummary from "@/components/tracking/RequestCountSummary";
import { FileText, Loader2, Plus, SearchX } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { filterRequests, getRequestListState } from "@/lib/request-list";
import RequestReadNotice from "@/components/RequestReadNotice";

export const Route = createFileRoute("/tracking")({
  component: TrackingPage,
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.request)
      ? search.request : undefined,
  }),
  head: () => ({
    meta: [
      { title: "My Requests — FinReq" },
      { name: "description", content: "Track status of your financial requests." },
      { property: "og:title", content: "My Requests — FinReq" },
      { property: "og:description", content: "Search your requests and follow their workflow status." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function TrackingPage() {
  const auth = useAuth();
  const { data, loading, readIssue, reload, syncState } = useFinancialRequests({ onlyMine: true, automatic: true });
  const [selected, setSelected] = useState<EnrichedRequest | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const { request: linkedRequestId } = Route.useSearch();
  const openedLink = useRef<string | undefined>(undefined);

  const myRequests = useMemo(
    () =>
      data.filter((r) => {
        if (!auth.user) return false;
        // Local prototype rows: only show ones saved by this signed-in user.
        if (r.prototype) return r.userId === auth.user.id;
        return r.userId === auth.user.id;
      }),
    [data, auth.user],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      All: myRequests.length,
      Submitted: 0,
      "Under Review": 0,
      Approved: 0,
      Rejected: 0,
      Completed: 0,
    };
    for (const r of myRequests) counts[r.status] += 1;
    return counts;
  }, [myRequests]);

  useEffect(() => {
    if (loading || readIssue || !linkedRequestId || openedLink.current === linkedRequestId) return;
    const linked = myRequests.find(row => row.uuid === linkedRequestId && !row.prototype);
    if (linked) {
      setSelected(linked);
      openedLink.current = linkedRequestId;
    }
  }, [loading, readIssue, linkedRequestId, myRequests]);

  const filteredRequests = useMemo(
    () => filterRequests(myRequests, { search, status: statusFilter, scope: "tracking" }),
    [myRequests, search, statusFilter],
  );
  const listState = getRequestListState(loading, filteredRequests.length, readIssue);

  const isFiltered = search.trim() !== "" || statusFilter !== "All";
  const prototypeCount = filteredRequests.filter((r) => r.prototype).length;
  // Always read the open detail from the latest authorized rows, not a stale snapshot.
  const currentSelection = !readIssue && auth.user && !auth.needsMfa
    ? myRequests.find(row => row.uuid === selected?.uuid) ?? null : null;

  const pending = filteredRequests.filter(
    (r) => r.status === "Submitted" || r.status === "Under Review",
  );
  const submitted = filteredRequests.filter(
    (r) => r.status === "Approved" || r.status === "Rejected" || r.status === "Completed",
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track the progress of your submissions
          </p>
        </div>
        <Link
          to="/submit"
          className="inline-flex items-center gap-2 self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New Request
        </Link>
      </div>

      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {syncState === "offline" ? "Offline — displayed statuses may be out of date."
          : syncState === "error" ? "Status checks failed — retrying automatically."
          : syncState === "checking" ? "Checking request statuses…"
          : syncState === "paused" ? "Status checks paused."
          : "Statuses up to date"}
      </p>

      {!loading && (
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <RequestSearchBar value={search} onChange={setSearch} />
            <RequestCountSummary
              matching={filteredRequests.length}
              total={myRequests.length}
              prototypeCount={prototypeCount}
              isFiltered={isFiltered}
            />
          </div>
          <StatusFilterChips
            value={statusFilter}
            onChange={setStatusFilter}
            counts={statusCounts}
          />
        </div>
      )}

      <RequestReadNotice issue={readIssue} />
      {!loading && !readIssue && linkedRequestId && !myRequests.some(row => row.uuid === linkedRequestId && !row.prototype) && (
        <p role="alert" className="text-sm text-muted-foreground">This request is unavailable or is not yours to view.</p>
      )}

      {listState === "loading" ? (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : listState === "restricted" || listState === "unavailable" ? null : myRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-20 shadow-sm">
          <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">You haven't submitted any requests yet.</p>
          <Link to="/submit" className="mt-3 text-sm font-medium text-primary hover:underline">
            Create your first request
          </Link>
        </div>
      ) : filteredRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 py-16">
          <SearchX className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No requests match your search and filters.
          </p>
          <button
            onClick={() => {
              setSearch("");
              setStatusFilter("All");
            }}
            className="mt-3 text-sm font-medium text-primary hover:underline"
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          <Group
            title="Pending Requests"
            subtitle="Awaiting review or decision"
            requests={pending}
            onSelect={setSelected}
            emptyText="No pending requests."
          />
          <Group
            title="Submitted Requests"
            subtitle="Approved, denied, or completed"
            requests={submitted}
            onSelect={setSelected}
            emptyText="No completed requests yet."
          />
        </div>
      )}

      <RequestDetailDialog
        request={currentSelection}
        onClose={() => setSelected(null)}
        onDecisionRecorded={async () => {
          setSelected(null);
          await reload();
        }}
      />
    </div>
  );
}

function Group({
  title,
  subtitle,
  requests,
  onSelect,
  emptyText,
}: {
  title: string;
  subtitle: string;
  requests: EnrichedRequest[];
  onSelect: (r: EnrichedRequest) => void;
  emptyText: string;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {requests.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card/50 px-5 py-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <div className="space-y-4">
          {requests.map((req) => (
            <button
              key={req.uuid}
              onClick={() => onSelect(req)}
              className="block w-full space-y-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-card-foreground">
                      {req.title}
                    </h3>
                    <StatusBadge status={req.status} />
                    {req.prototype && (
                      <span
                        title="Saved locally on this device only — not stored in the backend"
                        className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning"
                      >
                        Prototype · local only
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {req.id} · {formatCurrency(req.amount)} · {req.fundingType} Fund
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-muted-foreground">Submitted</p>
                  <p className="font-medium text-card-foreground">{req.submittedAt}</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <WorkflowTracker status={req.status} />
              </div>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {req.description}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
