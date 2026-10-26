import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, FileCheck2, Home, Loader2, Paperclip, Route as RouteIcon, UploadCloud, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import submitHero from "@/assets/submit-hero.jpg";
import type { FundingSource } from "@/lib/validation/request-schema";
import type { RoutingDecision } from "@/lib/routing/engine";
import { previewRouting } from "@/lib/routing/preview";
import { useSubmitRequest } from "@/hooks/useSubmitRequest";
import { ApprovalChain, ErrorText, FlowStep, Input, Meta } from "@/components/submit/FormFields";

export const Route = createFileRoute("/submit")({
  component: SubmitPage,
  head: () => ({
    meta: [
      { title: "Submit Request — FinReq" },
      { name: "description", content: "Submit a validated financial request with attachments and automated workflow routing." },
    ],
  }),
});

function SubmitPage() {
  const auth = useAuth();
  const { submitting, result, errors, submitError, submit, clearFeedback, dismissResult } = useSubmitRequest(auth.user);
  const [fundingSource, setFundingSource] = useState<FundingSource | "">("");
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<RoutingDecision | null>(null);
  const defaultEmail = auth.user?.email ?? "";
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    await submit(data, files, () => {
      form.reset();
      setFiles([]);
      setFundingSource("");
      setPreview(null);
    });
  };

  if (result) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Overview
        </Link>
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-xl shadow-primary/5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <h1 className="mt-5 text-2xl font-bold text-card-foreground">Request submitted and routed</h1>
          <p className="mt-2 text-sm text-muted-foreground">A tracking record, timestamp, attachment manifest, and automation event were created.</p>
          {result.warning && <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm font-medium text-warning">{result.warning}</p>}
          <div className="mt-6 grid gap-3 text-left sm:grid-cols-2">
            <Meta label="Request ID" value={result.id} />
            <Meta label="Timestamp" value={new Date(result.createdAt).toLocaleString()} />
            <Meta label="Routed to" value={result.routedTo} />
            <Meta label="Workflow" value={result.workflow} />
          </div>
          <ApprovalChain routing={result.routing} className="mt-4 text-left" />
          <div className="mt-7 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <button onClick={dismissResult} className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
              Submit another request
            </button>
            <Link to="/tracking" className="rounded-md border border-border bg-background px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-accent">
              View My Requests
            </Link>
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-accent">
              <Home className="h-4 w-4" /> Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Overview
        </Link>
        <Link to="/tracking" className="hidden text-sm font-medium text-primary hover:underline sm:inline">
          View my requests →
        </Link>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0">
          <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-primary/5">
            <div className="grid gap-6 p-6 md:grid-cols-[1fr_15rem] md:items-center">
              <div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  <Zap className="h-3.5 w-3.5" />
                  Automated workflow enabled
                </div>
                <h1 className="text-3xl font-bold text-card-foreground">New financial request</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Submit validated funding requests with conditional fields, supporting files, generated metadata, and immediate routing.</p>
              </div>
              <img src={submitHero} alt="University finance team submitting a request" width={1024} height={768} loading="lazy" className="hidden h-40 w-full rounded-xl object-cover md:block" />
            </div>
            <div className="border-t border-border bg-background/60 px-6 py-3">
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <RouteIcon className="h-4 w-4 text-primary" />
                <FlowStep text="Validate" active />
                <FlowStep text="Attach" active />
                <FlowStep text="Route" active />
              </div>
            </div>
          </div>

        <form onSubmit={handleSubmit} onChange={(event) => setPreview(previewRouting(event.currentTarget))} className="space-y-5">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <Input name="requesterEmail" label="Requester email" type="email" defaultValue={defaultEmail} placeholder="name@howard.edu" error={errors.requesterEmail} />
              <Input name="department" label="Department" defaultValue={auth.profile?.department ?? ""} placeholder="Chemistry" error={errors.department} />
              <Input name="amount" label="Amount (USD)" type="number" min="0" step="0.01" placeholder="0.00" error={errors.amount} />
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">Funding source</span>
                <select name="fundingSource" value={fundingSource} onChange={(event) => setFundingSource(event.target.value as FundingSource)} className={`h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring ${errors.fundingSource ? "border-destructive" : "border-input"}`}>
                  <option value="">Select funding source…</option>
                  <option value="department">Department Fund</option>
                  <option value="research">Research (R) Fund</option>
                  <option value="university">University (U) Fund</option>
                </select>
                {errors.fundingSource && <ErrorText text={errors.fundingSource} />}
              </label>
              <Input name="neededBy" label="Needed by" type="date" min={today} error={errors.neededBy} />
            </div>

            {fundingSource === "research" && (
              <div className="mt-4 grid gap-4 rounded-xl border border-border bg-background p-4 md:grid-cols-2">
                <Input name="grantNumber" label="Grant number" placeholder="GR-2026-1048" error={errors.grantNumber} />
                <Input name="principalInvestigator" label="Principal investigator" placeholder="Dr. Sarah Chen" error={errors.principalInvestigator} />
              </div>
            )}

            {fundingSource === "university" && (
              <div className="mt-4 rounded-xl border border-border bg-background p-4">
                <Input name="universityProgram" label="University program" placeholder="Student Success Initiative" error={errors.universityProgram} />
              </div>
            )}

            <div className="mt-4">
              <span className="mb-1.5 block text-xs font-semibold text-foreground">Priority</span>
              <div className="grid grid-cols-3 gap-2">
                {["low", "medium", "high"].map((priority) => (
                  <label key={priority} className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium capitalize text-foreground has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary">
                    <input className="sr-only" type="radio" name="priority" value={priority} defaultChecked={priority === "medium"} />
                    {priority}
                  </label>
                ))}
              </div>
            </div>

            <label className="mt-4 block">
              <span className="mb-1.5 block text-xs font-semibold text-foreground">Business justification</span>
              <textarea name="description" rows={5} className={`w-full resize-none rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring ${errors.description ? "border-destructive" : "border-input"}`} placeholder="Describe the purpose, funding rationale, and expected outcome…" />
              {errors.description && <ErrorText text={errors.description} />}
            </label>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-input bg-background px-4 py-8 text-center transition hover:border-primary/60 hover:bg-primary/5">
              <UploadCloud className="h-8 w-8 text-primary" />
              <span className="mt-2 text-sm font-semibold text-foreground">Upload supporting attachments</span>
              <span className="mt-1 text-xs text-muted-foreground">Receipts, quotes, approvals, or justification documents</span>
              <input className="sr-only" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            </label>
            {files.length > 0 && (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {files.map((file) => (
                  <div key={`${file.name}-${file.size}`} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                    <Paperclip className="h-3.5 w-3.5 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span>{Math.ceil(file.size / 1024)} KB</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            {submitError && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive sm:basis-full"><AlertCircle className="mr-1 inline h-4 w-4" />{submitError}</p>}
            <button disabled={submitting} type="submit" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />}
              Submit and trigger workflow
            </button>
            <button type="reset" onClick={() => { setFundingSource(""); setFiles([]); clearFeedback(); setPreview(null); }} className="rounded-md border border-border bg-background px-6 py-2.5 text-sm font-semibold text-foreground transition hover:bg-accent">
              Clear form
            </button>
          </div>
        </form>
      </section>

      <aside className="space-y-4">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <CalendarDays className="h-7 w-7 text-primary" />
          <h2 className="mt-3 text-base font-bold text-card-foreground">Generated automatically</h2>
          <div className="mt-4 space-y-3 text-sm">
            <Meta label="Request ID" value="FR-YYYY-XXXXXX" />
            <Meta label="Timestamp" value="At submission" />
            <Meta label="Workflow" value={preview ? preview.primaryLabel : "Based on funding source and amount"} />
          </div>
          {preview && <ApprovalChain routing={preview} className="mt-4" />}
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <AlertCircle className="h-7 w-7 text-warning" />
          <h2 className="mt-3 text-base font-bold text-card-foreground">Validation rules</h2>
          <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
            <li>• Required fields are checked before routing.</li>
            <li>• Email must be a Howard University address (@howard.edu).</li>
            <li>• Research and university funds reveal only relevant fields.</li>
            <li>• The same rules are re-checked by the database before saving.</li>
          </ul>
        </div>
      </aside>
      </div>
    </div>
  );
}
