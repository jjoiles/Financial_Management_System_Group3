import type { FundingType, RequestStatus } from "./mock-data";

export const REQUEST_SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "amount-desc", label: "Amount High to Low" },
  { value: "amount-asc", label: "Amount Low to High" },
] as const;

export type RequestSort = (typeof REQUEST_SORT_OPTIONS)[number]["value"];
type ListRequest = {
  id: string;
  title: string;
  email: string;
  department: string;
  status: RequestStatus;
  fundingType: FundingType;
  amount: number;
  submittedAt: string;
  createdAt?: string;
};

export function filterRequests<T extends ListRequest>(
  requests: readonly T[],
  options: {
    search?: string;
    status?: RequestStatus | "" | "All";
    funding?: FundingType | "";
    scope?: "all" | "tracking";
  } = {},
): T[] {
  const query = (options.search ?? "").trim().toLowerCase();
  return requests.filter((request) => {
    if (options.status && options.status !== "All" && request.status !== options.status) return false;
    if (options.funding && request.fundingType !== options.funding) return false;
    const fields = options.scope === "tracking"
      ? [request.title, request.id]
      : [request.title, request.id, request.email, request.department];
    return !query || fields.some((field) => field.toLowerCase().includes(query));
  });
}

export function sortRequests<T extends ListRequest>(requests: readonly T[], sort: RequestSort): T[] {
  const timestamp = (request: T) => {
    const value = Date.parse(request.createdAt ?? request.submittedAt);
    return Number.isFinite(value) ? value : 0;
  };
  return [...requests].sort((a, b) => {
    if (sort === "amount-desc") return b.amount - a.amount;
    if (sort === "amount-asc") return a.amount - b.amount;
    return sort === "oldest" ? timestamp(a) - timestamp(b) : timestamp(b) - timestamp(a);
  });
}

export type RequestReadIssue = { kind: "access" | "unavailable"; message: string };

export function classifyRequestReadError(error: unknown): RequestReadIssue {
  const value = error && typeof error === "object"
    ? error as { code?: string; status?: number; message?: string }
    : {};
  const message = value.message ?? (typeof error === "string" ? error : "");
  if (value.code === "42501" || value.code === "PGRST301" || value.code === "PGRST302" ||
      value.status === 401 || value.status === 403 ||
      /permission denied|row.level security|not authorized|access denied|jwt expired/i.test(message)) {
    return { kind: "access", message: "Access restricted. Your current session does not have permission to load these requests. Sign in again or contact your administrator if you believe you should have access." };
  }
  return { kind: "unavailable", message: "Backend requests could not be loaded. Please refresh to try again. Any requests shown as prototype are saved on this device only." };
}

// RLS remains authoritative for backend rows. Local storage has no RLS, so it
// must never be treated as a shared admin/reviewer store.
export function selectVisibleRequests<T extends { userId: string | null; prototype: boolean }>(
  requests: readonly T[], userId: string | undefined, onlyMine: boolean,
): T[] {
  if (!userId) return [];
  return requests.filter((request) =>
    request.prototype || onlyMine ? request.userId === userId : true,
  );
}

export function getRequestListState(loading: boolean, count: number, issue: RequestReadIssue | null) {
  if (loading) return "loading";
  if (count > 0) return "ready";
  if (issue?.kind === "access") return "restricted";
  if (issue) return "unavailable";
  return "empty";
}