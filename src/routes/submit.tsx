import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Upload, CheckCircle2 } from "lucide-react";
import type { FundingType } from "@/lib/mock-data";

export const Route = createFileRoute("/submit")({
  component: SubmitPage,
  head: () => ({
    meta: [
      { title: "Submit Request — FinReq" },
      { name: "description", content: "Submit a new financial request for processing." },
    ],
  }),
});

function SubmitPage() {
  const [fundingType, setFundingType] = useState<FundingType | "">("");
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const newErrors: Record<string, string> = {};

    if (!data.get("title")) newErrors.title = "Required";
    if (!data.get("fundingType")) newErrors.fundingType = "Required";
    if (!data.get("amount")) newErrors.amount = "Required";
    if (!data.get("description")) newErrors.description = "Required";

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitted(true);
  };

  if (submitted) {
    const requestId = `FR-2025-${String(Math.floor(Math.random() * 900) + 100)}`;
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 mb-4">
          <CheckCircle2 className="h-8 w-8 text-success" />
        </div>
        <h2 className="text-xl font-bold font-[family-name:var(--font-display)] text-foreground">Request Submitted</h2>
        <p className="mt-2 text-sm text-muted-foreground">Your request ID is <strong className="text-foreground">{requestId}</strong></p>
        <p className="text-xs text-muted-foreground mt-1">Submitted on {new Date().toLocaleDateString()}</p>
        <button
          onClick={() => { setSubmitted(false); setErrors({}); }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Submit Another
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-foreground">New Financial Request</h1>
      <p className="text-sm text-muted-foreground mt-1 mb-6">Fill out the form below to submit a financial request for review.</p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-xl border border-border bg-card p-6 space-y-5">
          {/* Title */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">Request Title *</label>
            <input
              name="title"
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${errors.title ? "border-destructive" : "border-input"}`}
              placeholder="e.g., Lab Equipment Purchase"
            />
            {errors.title && <p className="text-xs text-destructive mt-1">{errors.title}</p>}
          </div>

          {/* Funding Type */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">Funding Type *</label>
            <select
              name="fundingType"
              value={fundingType}
              onChange={(e) => setFundingType(e.target.value as FundingType)}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring ${errors.fundingType ? "border-destructive" : "border-input"}`}
            >
              <option value="">Select funding type…</option>
              <option value="Department">Department Fund</option>
              <option value="R">Research (R) Fund</option>
              <option value="U">University (U) Fund</option>
            </select>
            {errors.fundingType && <p className="text-xs text-destructive mt-1">{errors.fundingType}</p>}
          </div>

          {/* Conditional: Research fields */}
          {fundingType === "R" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">Grant Number</label>
                <input name="grantNumber" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="GR-XXXX" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">PI Name</label>
                <input name="piName" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Principal Investigator" />
              </div>
            </div>
          )}

          {/* Conditional: University fields */}
          {fundingType === "U" && (
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">University Program</label>
              <input name="program" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="e.g., Student Success Initiative" />
            </div>
          )}

          {/* Amount & Department */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">Amount (USD) *</label>
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${errors.amount ? "border-destructive" : "border-input"}`}
                placeholder="0.00"
              />
              {errors.amount && <p className="text-xs text-destructive mt-1">{errors.amount}</p>}
            </div>
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">Department</label>
              <input name="department" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="e.g., Chemistry" />
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">Priority</label>
            <div className="flex gap-3">
              {["Low", "Medium", "High"].map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input type="radio" name="priority" value={p} defaultChecked={p === "Medium"} className="accent-primary" />
                  {p}
                </label>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">Description *</label>
            <textarea
              name="description"
              rows={4}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none ${errors.description ? "border-destructive" : "border-input"}`}
              placeholder="Provide details about this financial request…"
            />
            {errors.description && <p className="text-xs text-destructive mt-1">{errors.description}</p>}
          </div>

          {/* File Upload */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">Attachments</label>
            <div className="flex items-center justify-center rounded-lg border-2 border-dashed border-input bg-muted/30 py-8 transition-colors hover:border-primary/30">
              <div className="text-center">
                <Upload className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Drop files here or click to upload</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">PDF, DOC, JPG up to 10MB</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Submit Request
          </button>
          <button
            type="reset"
            onClick={() => { setFundingType(""); setErrors({}); }}
            className="rounded-md border border-border bg-background px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Clear Form
          </button>
        </div>
      </form>
    </div>
  );
}
