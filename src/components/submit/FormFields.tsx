import type { InputHTMLAttributes } from "react";
import { AlertCircle } from "lucide-react";
import type { RoutingDecision } from "@/lib/routing/engine";

export function Input({
  label,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-foreground">{label}</span>
      <input
        {...props}
        className={`h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring ${error ? "border-destructive" : "border-input"}`}
      />
      {error && <ErrorText text={error} />}
    </label>
  );
}

export function ErrorText({ text }: { text: string }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive">
      <AlertCircle className="h-3 w-3" />
      {text}
    </p>
  );
}

export function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

export function FlowStep({ text, active }: { text: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${active ? "bg-success" : "bg-muted"}`} />
      {text}
    </div>
  );
}

export function ApprovalChain({
  routing,
  className = "",
}: {
  routing: RoutingDecision;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-border bg-background p-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Approval chain</p>
        {routing.flags.includes("expedited") && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
            Expedited
          </span>
        )}
        {routing.flags.includes("high_value") && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            High value
          </span>
        )}
      </div>
      <ol className="mt-2 space-y-1.5">
        {routing.approvalChain.map((step) => (
          <li key={step.queue} className="text-xs text-foreground">
            <span className="font-semibold">
              {step.step}. {step.label}
            </span>
            <span className="block text-muted-foreground">{step.reason}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
