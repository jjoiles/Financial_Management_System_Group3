import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useFinancialRequests, type EnrichedRequest } from "@/lib/requests-data";
import StatusBadge from "@/components/StatusBadge";
import RequestDetailDialog from "@/components/RequestDetailDialog";
import { Search, Filter, Loader2, FileText } from "lucide-react";
import type { FundingType, RequestStatus } from "@/lib/mock-data";
import { formatCurrency } from "@/lib/format";
import { filterRequests, sortRequests, REQUEST_SORT_OPTIONS, getRequestListState, type RequestSort } from "@/lib/request-list";
import RequestReadNotice from "@/components/RequestReadNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export const Route = createFileRoute("/requests")({
  component: RequestsPage,
  head: () => ({
    meta: [
      { title: "All Requests — FinReq" },
      { name: "description", content: "View and manage all financial requests." },
      { property: "og:title", content: "All Requests — FinReq" },
      { property: "og:description", content: "Search, filter, sort, and review financial requests." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function RequestsPage() {
  const { data, loading, readIssue, reload } = useFinancialRequests();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RequestStatus | "">("");
  const [fundingFilter, setFundingFilter] = useState<FundingType | "">("");
  const [sort, setSort] = useState<RequestSort>("newest");
  const [selected, setSelected] = useState<EnrichedRequest | null>(null);

  const filtered = useMemo(
    () => sortRequests(filterRequests(data, { search, status: statusFilter, funding: fundingFilter }), sort),
    [data, search, statusFilter, fundingFilter, sort],
  );
  const listState = getRequestListState(loading, filtered.length, readIssue);

  const pending = filtered.filter((r) => r.status === "Submitted" || r.status === "Under Review");
  const decided = filtered.filter(
    (r) => r.status === "Approved" || r.status === "Rejected" || r.status === "Completed",
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">All Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered.length} requests{" "}
            {search || statusFilter || fundingFilter ? "matched" : "total"}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={loading}
          onClick={() => reload()}
          className="self-start"
        >
          Refresh
        </Button>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search requests"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-background pl-9"
            placeholder="Search by ID, title, requester, department…"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            aria-label="Filter by status"
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
            aria-label="Filter by funding"
            value={fundingFilter}
            onChange={(e) => setFundingFilter(e.target.value as FundingType | "")}
            className="rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Funding</option>
            <option value="Department">Department</option>
            <option value="R">Research (R)</option>
            <option value="U">University (U)</option>
          </select>
          <Select value={sort} onValueChange={(value) => setSort(value as RequestSort)}>
            <SelectTrigger aria-label="Sort requests" className="w-[190px] bg-background text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REQUEST_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <RequestReadNotice issue={readIssue} />

      {listState === "loading" ? (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading requests…
        </div>
      ) : listState === "restricted" || listState === "unavailable" ? null : listState === "empty" ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          <Section
            title="Pending Requests"
            count={pending.length}
            requests={pending}
            onSelect={setSelected}
          />
          <Section
            title="Submitted & Decided"
            count={decided.length}
            requests={decided}
            onSelect={setSelected}
          />
        </div>
      )}

      <RequestDetailDialog
        request={selected}
        onClose={() => setSelected(null)}
        onDecisionRecorded={async () => {
          setSelected(null);
          await reload();
        }}
      />
    </div>
  );
}

function Section({
  title,
  count,
  requests,
  onSelect,
}: {
  title: string;
  count: number;
  requests: EnrichedRequest[];
  onSelect: (r: EnrichedRequest) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {count}
        </span>
      </div>
      {/* Desktop table */}
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">ID</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              Title
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              Department
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              Funding
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
              Amount
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              Status
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
              Date
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {requests.map((r) => (
            <tr
              key={r.uuid}
              onClick={() => onSelect(r)}
              className="cursor-pointer transition hover:bg-accent/40"
            >
              <td className="px-4 py-3 font-mono text-xs text-primary">{r.id}</td>
              <td className="px-4 py-3 font-medium text-card-foreground">{r.title}</td>
              <td className="px-4 py-3 text-muted-foreground">{r.department}</td>
              <td className="px-4 py-3 text-muted-foreground">{r.fundingType}</td>
              <td className="px-4 py-3 text-right font-medium text-card-foreground">
                {formatCurrency(r.amount)}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{r.submittedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Mobile cards */}
      <div className="divide-y divide-border md:hidden">
        {requests.map((r) => (
          <button
            key={r.uuid}
            onClick={() => onSelect(r)}
            className="flex w-full flex-col gap-2 px-4 py-3 text-left transition hover:bg-accent/40"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-primary">{r.id}</p>
                <p className="truncate text-sm font-medium text-card-foreground">{r.title}</p>
              </div>
              <StatusBadge status={r.status} />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {r.department} · {r.fundingType}
              </span>
              <span className="font-medium text-card-foreground">{formatCurrency(r.amount)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-16">
      <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No requests match your filters.</p>
    </div>
  );
}
