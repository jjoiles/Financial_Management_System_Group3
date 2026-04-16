import type { RequestStatus } from "@/lib/mock-data";

const statusClasses: Record<RequestStatus, string> = {
  Submitted: "status-submitted",
  "Under Review": "status-review",
  Approved: "status-approved",
  Rejected: "status-rejected",
  Completed: "status-completed",
};

export default function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClasses[status]}`}>
      {status}
    </span>
  );
}
