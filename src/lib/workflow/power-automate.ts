import type { RoutingDecision } from "@/lib/routing/engine";

// F7: Power Automate client. Pure helpers with no Supabase or env access, so
// they can be tested on their own. The server function in
// initialize-workflow.ts supplies the URL, secret, and fetch.

export const FLOW_SCHEMA_VERSION = 1;

export type RequestRow = {
  id: string;
  request_number: string;
  user_id: string;
  title: string;
  requester_email: string;
  department: string;
  funding_source: "department" | "research" | "university";
  amount: number | string;
  needed_by: string;
  priority: "low" | "medium" | "high";
  grant_number: string | null;
  principal_investigator: string | null;
  university_program: string | null;
  status: string;
  created_at: string;
};

// Body sent to the "When an HTTP request is received" trigger. Matches
// docs/power-automate/finreq-request-submitted.schema.json.
export type FlowPayload = {
  schemaVersion: number;
  event: "request.submitted";
  requestId: string;
  requestNumber: string;
  submittedAt: string;
  status: string;
  requester: { userId: string; email: string };
  department: string;
  fundingSource: RequestRow["funding_source"];
  amount: number;
  currency: "USD";
  neededBy: string;
  priority: RequestRow["priority"];
  title: string;
  research: { grantNumber: string; principalInvestigator: string } | null;
  universityProgram: string | null;
  routing: {
    primaryQueue: string;
    primaryLabel: string;
    approvalChain: { step: number; queue: string; label: string }[];
    flags: string[];
    rulesVersion: string;
  };
  appUrl: string | null;
};

export function buildFlowPayload(
  row: RequestRow,
  routing: RoutingDecision,
  appBaseUrl?: string,
): FlowPayload {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    event: "request.submitted",
    requestId: row.id,
    requestNumber: row.request_number,
    submittedAt: row.created_at,
    status: row.status,
    requester: { userId: row.user_id, email: row.requester_email },
    department: row.department,
    fundingSource: row.funding_source,
    amount: Number(row.amount),
    currency: "USD",
    neededBy: row.needed_by,
    priority: row.priority,
    title: row.title,
    research:
      row.funding_source === "research" && row.grant_number && row.principal_investigator
        ? {
            grantNumber: row.grant_number,
            principalInvestigator: row.principal_investigator,
          }
        : null,
    universityProgram: row.university_program,
    routing: {
      primaryQueue: routing.primaryQueue,
      primaryLabel: routing.primaryLabel,
      approvalChain: routing.approvalChain.map(({ step, queue, label }) => ({
        step,
        queue,
        label,
      })),
      flags: routing.flags,
      rulesVersion: routing.rulesVersion,
    },
    appUrl: appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/requests?id=${encodeURIComponent(row.request_number)}`
      : null,
  };
}

// HMAC-SHA256 of the raw body, hex encoded. Lets the flow reject calls that
// did not come from FinReq. Uses Web Crypto so it runs on Cloudflare Workers.
export async function signBody(body: string, secret: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type FlowResult =
  | { ok: true; httpStatus: number; attempts: number; runId: string | null }
  | {
      ok: false;
      httpStatus: number | null;
      attempts: number;
      error: string;
    };

export type PostOptions = {
  url: string;
  secret?: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
};

const retryable = (status: number) => status === 429 || status >= 500;

export function isAllowedFlowUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// POSTs the payload. Retries network errors, timeouts, 429, and 5xx with
// backoff. 4xx (except 429) is a configuration problem and is not retried.
export async function postToFlow(payload: FlowPayload, options: PostOptions): Promise<FlowResult> {
  const {
    url,
    secret,
    idempotencyKey,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    retryDelaysMs = [500, 1500],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (!isAllowedFlowUrl(url)) {
    return {
      ok: false,
      httpStatus: null,
      attempts: 0,
      error: "Flow URL must be https.",
    };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-finreq-idempotency-key": idempotencyKey,
    "x-finreq-schema-version": String(FLOW_SCHEMA_VERSION),
  };
  if (secret) headers["x-finreq-signature"] = await signBody(body, secret);

  let lastError = "Unknown error";
  let lastStatus: number | null = null;
  const maxAttempts = retryDelaysMs.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.ok) {
        return {
          ok: true,
          httpStatus: res.status,
          attempts: attempt,
          runId: res.headers.get("x-ms-workflow-run-id"),
        };
      }
      lastError = `Flow returned HTTP ${res.status}.`;
      if (!retryable(res.status)) {
        return {
          ok: false,
          httpStatus: res.status,
          attempts: attempt,
          error: lastError,
        };
      }
    } catch (err) {
      lastError =
        err instanceof Error && err.name === "AbortError"
          ? `Flow did not respond within ${timeoutMs / 1000}s.`
          : `Could not reach flow: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) await sleep(retryDelaysMs[attempt - 1]);
  }

  return {
    ok: false,
    httpStatus: lastStatus,
    attempts: maxAttempts,
    error: lastError,
  };
}
