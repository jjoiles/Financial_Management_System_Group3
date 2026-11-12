import type { RequestStatus } from "@/lib/mock-data";

export type StatusFilter = "All" | RequestStatus;

export const STATUS_FILTERS: StatusFilter[] = [
  "All",
  "Submitted",
  "Under Review",
  "Approved",
  "Rejected",
  "Completed",
];

/**
 * Horizontal chip row for filtering requests by status.
 * Controlled component — filtering logic lives in the parent page.
 */
export default function StatusFilterChips({
  value,
  onChange,
  counts,
}: {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter requests by status">
      {STATUS_FILTERS.map((status) => {
        const isActive = value === status;
        return (
          <button
            key={status}
            type="button"
            onClick={() => onChange(status)}
            aria-pressed={isActive}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {status}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {counts[status]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
