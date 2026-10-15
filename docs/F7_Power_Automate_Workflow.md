# F7: Power Automate Workflow Initialization

## Overview

Before F7, the submit page wrote a `workflow_triggered` event and showed "Power Automate simulation". Nothing was sent anywhere, and `workflow_triggered_at` was set before any workflow ran.

F7 adds a server function that starts a real Power Automate flow through its HTTP trigger after a request is saved. If no flow URL is configured, it runs in simulated mode and logs that clearly, so the app works the same in development and in the demo.

---

## What We Built

### 1. Server function `initializeWorkflow`

**Location:** `src/lib/workflow/initialize-workflow.ts`

Called by `/submit` right after the request and attachments are saved. It runs on the server (Cloudflare Worker) as the signed-in user, so Supabase RLS still applies.

Steps:

1. **Load** the request. Returns 404 if the user cannot see it.
2. **Idempotency check.** If a `workflow_initialized` event already exists, it returns without sending again. Safe to retry.
3. **Recompute routing** with the F8 engine. If the stored `routed_to` does not match, the server value wins. A modified browser cannot pick its own approver.
4. **POST to Power Automate** (or simulate if no URL).
5. **Record the outcome** in `workflow_events` and set `workflow_triggered_at` only after the flow accepts the request.

### 2. Modes

| Mode | When | `workflow_events.event_type` | `workflow_triggered_at` |
|---|---|---|---|
| `power_automate` | Flow returned 2xx | `workflow_initialized` | set |
| `simulated` | `POWER_AUTOMATE_FLOW_URL` not set | `workflow_initialized` | set |
| `failed` | Flow unreachable or returned an error after retries | `workflow_failed` | not set |

A failed start does not lose the request. It stays saved, the user sees a warning, and calling `initializeWorkflow` again retries.

### 3. Power Automate client

**Location:** `src/lib/workflow/power-automate.ts`

- `buildFlowPayload()` builds the JSON body (schema below)
- `postToFlow()` sends it with a 10s timeout per attempt; retries network errors, timeouts, 429, and 5xx twice (0.5s, then 1.5s); does not retry other 4xx since those mean the flow is misconfigured; requires `https`
- `signBody()` adds an HMAC-SHA256 signature when a shared secret is set

Headers sent:

| Header | Value |
|---|---|
| `x-finreq-idempotency-key` | request UUID, so the flow can ignore duplicates |
| `x-finreq-schema-version` | `1` |
| `x-finreq-signature` | hex HMAC-SHA256 of the body (only if secret set) |

The flow URL is never written to the database or sent to the browser.

### 4. Payload

Full JSON schema: `docs/power-automate/finreq-request-submitted.schema.json`. Example:

```json
{
  "schemaVersion": 1,
  "event": "request.submitted",
  "requestId": "5b1f0b9e-...",
  "requestNumber": "FR-2026-ABC123",
  "submittedAt": "2026-10-15T16:00:00Z",
  "status": "submitted",
  "requester": { "userId": "...", "email": "jdoe@howard.edu" },
  "department": "Chemistry",
  "fundingSource": "research",
  "amount": 30000,
  "currency": "USD",
  "neededBy": "2026-12-01",
  "priority": "medium",
  "title": "Spectrometer service contract",
  "research": { "grantNumber": "NSF-2041", "principalInvestigator": "Dr. Sarah Chen" },
  "universityProgram": null,
  "routing": {
    "primaryQueue": "research_admin",
    "primaryLabel": "Research Administration",
    "approvalChain": [
      { "step": 1, "queue": "research_admin", "label": "Research Administration" },
      { "step": 2, "queue": "sponsored_programs", "label": "Office of Sponsored Programs" },
      { "step": 3, "queue": "cfo_office", "label": "Office of the CFO" }
    ],
    "flags": ["high_value", "multi_level"],
    "rulesVersion": "2026-10-15.1"
  },
  "appUrl": "https://<app>/requests?id=FR-2026-ABC123"
}
```

### 5. Submit page

- Calls `initializeWorkflow` with the user's access token
- Success screen shows a new **Workflow** field: Started in Power Automate, Simulated, or Not started
- The old client-side `workflow_triggered` insert is removed

---

## Setup

### Environment variables (server only)

| Name | Required | Purpose |
|---|---|---|
| `POWER_AUTOMATE_FLOW_URL` | No | HTTP trigger URL. Unset means simulated mode |
| `POWER_AUTOMATE_SHARED_SECRET` | No | Signs requests |
| `APP_BASE_URL` | No | Adds `appUrl` link back to the request |

Do not prefix these with `VITE_`; that would expose them in the browser. Set them as Lovable/Cloudflare secrets, or in `.dev.vars` locally (already gitignored).

### Building the flow in Power Automate

1. New **Instant cloud flow**, trigger **When an HTTP request is received**. Who can trigger: **Anyone** (the URL contains its own signature).
2. Paste `finreq-request-submitted.schema.json` into **Request Body JSON Schema**.
3. Add **Response** with status `202` right after the trigger so FinReq does not wait on approvals.
4. Add **Switch** on `routing.primaryQueue` and send an approval (Approvals connector) or email to the mailbox for each queue.
5. Optional: for each item in `routing.approvalChain`, run a sequential approval.
6. Save, copy the HTTP POST URL into `POWER_AUTOMATE_FLOW_URL`.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/workflow/initialize-workflow.ts` | New. Server function |
| `src/lib/workflow/power-automate.ts` | New. Payload, signing, POST with retries |
| `src/routes/submit.tsx` | Calls the server function; shows workflow status |
| `docs/power-automate/finreq-request-submitted.schema.json` | New. Trigger schema |

---

## How to Test

1. **Simulated:** leave `POWER_AUTOMATE_FLOW_URL` unset, submit a request. Success screen shows "Simulated (flow not connected)". In Supabase, `workflow_events` has a `workflow_initialized` row with `metadata.mode = "simulated"`.
2. **Real flow:** set the URL, submit. Flow run history shows the payload; FinReq shows "Started in Power Automate"; event metadata has `runId`.
3. **Failure:** set the URL to a flow that returns 400. FinReq shows the warning; event type is `workflow_failed`; `workflow_triggered_at` is null.
4. **Idempotency:** call `initializeWorkflow` twice for one request. Only one event is written and the flow runs once.
