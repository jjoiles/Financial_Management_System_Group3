import { LockKeyhole, AlertCircle } from "lucide-react";
import type { RequestReadIssue } from "@/lib/request-list";

export default function RequestReadNotice({ issue }: { issue: RequestReadIssue | null }) {
  if (!issue) return null;
  const Icon = issue.kind === "access" ? LockKeyhole : AlertCircle;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{issue.message}</p>
    </div>
  );
}