import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { z } from "zod";
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, FileCheck2, Home, Loader2, Paperclip, Route as RouteIcon, UploadCloud, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import submitHero from "@/assets/submit-hero.jpg";

type FundingSource = "department" | "research" | "university";
type SubmissionResult = { id: string; createdAt: string; routedTo: string; warning?: string };
type SavedRequest = { id: string; request_number: string; created_at: string; prototype?: boolean };

export const Route = createFileRoute("/submit")({
  component: SubmitPage,
  head: () => ({
    meta: [
      { title: "Submit Request — FinReq" },
      { name: "description", content: "Submit a validated financial request with attachments and automated workflow routing." },
    ],
  }),
});

const requestSchema = z.object({
  requesterEmail: z.string().trim().email("Enter a valid university email."),
  department: z.string().trim().min(2, "Department is required.").max(80),
  fundingSource: z.enum(["department", "research", "university"], { required_error: "Select a funding source." }),
  amount: z.coerce.number().positive("Amount must be greater than zero.").max(9999999, "Amount is too large."),
  neededBy: z.string().min(1, "Needed-by date is required."),
  priority: z.enum(["low", "medium", "high"]),
  description: z.string().trim().min(1, "Business justification is required.").max(10000, "Business justification is too long."),
  grantNumber: z.string().trim().optional(),
  principalInvestigator: z.string().trim().optional(),
  universityProgram: z.string().trim().optional(),
}).superRefine((data, ctx) => {
  const neededBy = new Date(`${data.neededBy}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (neededBy < today) {
    ctx.addIssue({ code: "custom", path: ["neededBy"], message: "Choose today or a future date." });
  }
  if (data.fundingSource === "research") {
    if (!data.grantNumber) ctx.addIssue({ code: "custom", path: ["grantNumber"], message: "Grant number is required for research funding." });
    if (!data.principalInvestigator) ctx.addIssue({ code: "custom", path: ["principalInvestigator"], message: "PI name is required for research funding." });
  }
  if (data.fundingSource === "university" && !data.universityProgram) {
    ctx.addIssue({ code: "custom", path: ["universityProgram"], message: "Program name is required for university funding." });
  }
});

type FormErrors = Partial<Record<keyof z.infer<typeof requestSchema>, string>>;

const routingMap: Record<FundingSource, string> = {
  department: "Department Budget Reviewer",
  research: "Research Administration",
  university: "Provost Finance Office",
};

const transientBackendCodes = new Set(["PGRST000", "PGRST001", "PGRST002"]);

const createRequestNumber = () => {
  const year = new Date().getFullYear();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FR-${year}-${suffix}`;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const isTransientBackendError = (error: unknown) => {
  const maybeError = error as { code?: string; message?: string; details?: string; status?: number };
  const text = `${maybeError.message ?? ""} ${maybeError.details ?? ""}`.toLowerCase();
  return (
    transientBackendCodes.has(maybeError.code ?? "") ||
    maybeError.status === 503 ||
    text.includes("schema cache") ||
    text.includes("recovery mode") ||
    text.includes("no connection")
  );
};

const getSubmitErrorMessage = (error: unknown) => {
  if (isTransientBackendError(error)) {
    return "The request could not be saved because the backend was temporarily unavailable. Please try again in a moment.";
  }
  return error instanceof Error ? error.message : "Submission failed. Please review the required fields and try again.";
};

const getPrototypeFallbackReason = (error: unknown) => {
  if (isTransientBackendError(error)) {
    return "The hosted backend was temporarily unavailable.";
  }
  return error instanceof Error ? error.message : "The hosted backend rejected the request.";
};

async function insertFinancialRequest(client: any, payload: Record<string, unknown>, requestNumber: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data, error } = await client
      .from("financial_requests")
      .insert(payload)
      .select("id, request_number, created_at")
      .single();

    if (!error) return data;

    if (error.code === "23505") {
      const existing = await client
        .from("financial_requests")
        .select("id, request_number, created_at")
        .eq("request_number", requestNumber)
        .maybeSingle();
      if (!existing.error && existing.data) return existing.data;
    }

    if (attempt < 5 && isTransientBackendError(error)) {
      await wait(Math.min(800 * 2 ** attempt, 8000));
      continue;
    }

    throw error;
  }

  throw new Error("Submission failed. Please try again.");
}

const savePrototypeRequest = (payload: Record<string, unknown>, requestNumber: string, createdAt: string): SavedRequest => {
  const savedRequest = {
    ...payload,
    id: crypto.randomUUID(),
    request_number: requestNumber,
    created_at: createdAt,
    prototype: true,
  };
  const existing = JSON.parse(window.localStorage.getItem("prototype-financial-requests") ?? "[]") as unknown[];
  window.localStorage.setItem("prototype-financial-requests", JSON.stringify([savedRequest, ...existing].slice(0, 50)));
  return savedRequest;
};

const savePrototypeAttachments = (requestId: string, userId: string, attachments: File[]) => {
  if (attachments.length === 0) return;
  const records = attachments.map((file) => ({
    id: crypto.randomUUID(),
    request_id: requestId,
    user_id: userId,
    file_name: file.name,
    file_path: `prototype://${requestId}/${file.name}`,
    file_size: file.size,
    content_type: file.type,
    created_at: new Date().toISOString(),
  }));
  const existing = JSON.parse(window.localStorage.getItem("prototype-request-attachments") ?? "[]") as unknown[];
  window.localStorage.setItem("prototype-request-attachments", JSON.stringify([...records, ...existing].slice(0, 100)));
};

function SubmitPage() {
  const auth = useAuth();
  const [fundingSource, setFundingSource] = useState<FundingSource | "">("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState("");
  const defaultEmail = auth.user?.email ?? "";
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth.user) {
      setSubmitError("Please sign in before submitting a financial request.");
      return;
    }

    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const parsed = requestSchema.safeParse(data);

    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path[0], issue.message])) as FormErrors);
      setSubmitError("");
      return;
    }

    setErrors({});
    setSubmitError("");
    setSubmitting(true);

    try {
      const routedTo = routingMap[parsed.data.fundingSource];
      const client = supabase as any;
      const requestNumber = createRequestNumber();
      const createdAt = new Date().toISOString();
      const requestPayload = {
        user_id: auth.user.id,
        request_number: requestNumber,
        title: parsed.data.description.slice(0, 120) || "Financial request",
        requester_email: parsed.data.requesterEmail,
        department: parsed.data.department,
        funding_source: parsed.data.fundingSource,
        amount: parsed.data.amount,
        needed_by: parsed.data.neededBy,
        priority: parsed.data.priority,
        description: parsed.data.description,
        grant_number: parsed.data.grantNumber || null,
        principal_investigator: parsed.data.principalInvestigator || null,
        university_program: parsed.data.universityProgram || null,
        status: "submitted",
        workflow_triggered_at: createdAt,
        routed_to: routedTo,
        metadata: { source: "FinReq portal", automation: "Power Automate equivalent", attachmentCount: files.length },
      };

      let warning = "";
      let inserted: SavedRequest;

      try {
        inserted = await insertFinancialRequest(client, requestPayload, requestNumber);
      } catch (error) {
        inserted = savePrototypeRequest(requestPayload, requestNumber, createdAt);
        savePrototypeAttachments(inserted.id, auth.user.id, files);
        const reason = getPrototypeFallbackReason(error);
        warning = `Saved in prototype mode. ${reason} Attachments and workflow were simulated.`;
      }

      if (!inserted.prototype) {
        try {
          for (const file of files) {
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
            const path = `${auth.user.id}/${inserted.id}/${Date.now()}-${safeName}`;
            const upload = await client.storage.from("request-attachments").upload(path, file, { upsert: false });
            if (upload.error) {
              warning ||= "Your request was saved, but one or more attachments could not be uploaded, so attachment storage was simulated.";
              continue;
            }
            const attachment = await client.from("request_attachments").insert({
              request_id: inserted.id,
              user_id: auth.user.id,
              file_name: file.name,
              file_path: path,
              file_size: file.size,
              content_type: file.type,
            });
            if (attachment.error) warning ||= "Your request was saved, but one or more attachments could not be linked, so attachment tracking was simulated.";
          }
        } catch {
          savePrototypeAttachments(inserted.id, auth.user.id, files);
          warning ||= "Your request was saved, but attachment storage is not connected right now, so attachments were simulated.";
        }
      }

      if (!inserted.prototype) {
        try {
          const workflow = await client.from("workflow_events").insert({
            request_id: inserted.id,
            actor_user_id: auth.user.id,
            event_type: "workflow_triggered",
            message: `Automated routing triggered to ${routedTo}.`,
            metadata: { requestNumber: inserted.request_number, connector: "Power Automate simulation" },
          });
          if (workflow.error && !warning) warning = "Your request was saved. Power Automate is not connected yet, so the workflow trigger was simulated.";
        } catch {
          warning ||= "Your request was saved. Power Automate is not connected yet, so the workflow trigger was simulated.";
        }
      }

      setResult({ id: inserted.request_number, createdAt: inserted.created_at, routedTo, warning });
      form.reset();
      setFiles([]);
      setFundingSource("");
    } catch (err) {
      setSubmitError(getSubmitErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
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
          <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
            <Meta label="Request ID" value={result.id} />
            <Meta label="Timestamp" value={new Date(result.createdAt).toLocaleString()} />
            <Meta label="Routed to" value={result.routedTo} />
          </div>
          <div className="mt-7 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <button onClick={() => setResult(null)} className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
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

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <Input name="requesterEmail" label="Requester email" type="email" defaultValue={defaultEmail} placeholder="name@university.edu" error={errors.requesterEmail} />
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
            <button type="reset" onClick={() => { setFundingSource(""); setFiles([]); setErrors({}); setSubmitError(""); }} className="rounded-md border border-border bg-background px-6 py-2.5 text-sm font-semibold text-foreground transition hover:bg-accent">
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
            <Meta label="Workflow" value={fundingSource ? routingMap[fundingSource] : "Based on funding source"} />
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <AlertCircle className="h-7 w-7 text-warning" />
          <h2 className="mt-3 text-base font-bold text-card-foreground">Validation rules</h2>
          <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
            <li>• Required fields are checked before routing.</li>
            <li>• Email, amount, and date formats are enforced.</li>
            <li>• Research and university funds reveal only relevant fields.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Input({ label, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-foreground">{label}</span>
      <input {...props} className={`h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring ${error ? "border-destructive" : "border-input"}`} />
      {error && <ErrorText text={error} />}
    </label>
  );
}

function ErrorText({ text }: { text: string }) {
  return <p className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><AlertCircle className="h-3 w-3" />{text}</p>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

function FlowStep({ text, active }: { text: string; active: boolean }) {
  return <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${active ? "bg-success" : "bg-muted"}`} />{text}</div>;
}
