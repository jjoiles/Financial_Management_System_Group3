import type { RequestStatus } from "@/lib/mock-data";
import { Check, Clock, X } from "lucide-react";

const steps: { label: string; statuses: RequestStatus[] }[] = [
  { label: "Submitted", statuses: ["Submitted", "Under Review", "Approved", "Rejected", "Completed"] },
  { label: "Under Review", statuses: ["Under Review", "Approved", "Rejected", "Completed"] },
  { label: "Decision", statuses: ["Approved", "Rejected", "Completed"] },
  { label: "Completed", statuses: ["Completed"] },
];

export default function WorkflowTracker({ status }: { status: RequestStatus }) {
  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => {
        const isActive = step.statuses.includes(status);
        const isRejected = status === "Rejected" && step.label === "Decision";
        const isCurrent = i === steps.findIndex((s) => !s.statuses.includes(status)) - 1 ||
          (status === "Completed" && i === steps.length - 1) ||
          (status === "Rejected" && step.label === "Decision");

        return (
          <div key={step.label} className="flex items-center gap-1">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                isRejected
                  ? "bg-destructive text-destructive-foreground"
                  : isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              } ${isCurrent ? "ring-2 ring-primary/30 ring-offset-2 ring-offset-background" : ""}`}
            >
              {isRejected ? <X className="h-3.5 w-3.5" /> : isActive ? <Check className="h-3.5 w-3.5" /> : <Clock className="h-3 w-3" />}
            </div>
            <span className={`text-[11px] mr-2 ${isActive ? "text-foreground font-medium" : "text-muted-foreground"}`}>
              {step.label}
            </span>
            {i < steps.length - 1 && (
              <div className={`h-px w-6 ${isActive ? "bg-primary" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
