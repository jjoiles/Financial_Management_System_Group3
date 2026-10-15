import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { routeRequest } from "@/lib/routing/engine";
import { buildFlowPayload, postToFlow, type RequestRow } from "./power-automate";

// F7: Power Automate Workflow Initialization
//
// Runs on the server after a request is saved. It:
//   1. Loads the request as the signed-in user (RLS still applies)
//   2. Recomputes routing so a modified client cannot choose its own route
//   3. POSTs the request to the Power Automate HTTP trigger
//   4. Records the outcome in workflow_events and sets workflow_triggered_at
//
// Server env (never VITE_ prefixed, so it never reaches the browser):
//   POWER_AUTOMATE_FLOW_URL        HTTP trigger URL. Unset = simulated mode.
//   POWER_AUTOMATE_SHARED_SECRET   Optional. Signs the body (x-finreq-signature).
//   APP_BASE_URL                   Optional. Adds a link back to the request.
//
// Safe to call more than once: a request that already has a successful
// workflow_initialized event is not sent again.

export type WorkflowMode = "power_automate" | "simulated" | "failed";

export type InitializeWorkflowResult = {
  mode: WorkflowMode;
  alreadyInitialized: boolean;
  attempts: number;
  routedTo: string;
  message: string;
};

const REQUEST_COLUMNS =
  "id, request_number, user_id, title, requester_email, department, funding_source, amount, needed_by, priority, grant_number, principal_investigator, university_program, status, created_at, routed_to, metadata";

export const initializeWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ requestId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<InitializeWorkflowResult> => {
    const db = context.supabase;

    const { data: row, error } = await db
      .from("financial_requests")
      .select(REQUEST_COLUMNS)
      .eq("id", data.requestId)
      .maybeSingle();
    if (error) throw new Error(`Could not load request: ${error.message}`);
    if (!row) throw new Response("Request not found", { status: 404 });

    const request = row as RequestRow & {
      routed_to: string | null;
      metadata: Record<string, unknown> | null;
    };

    // 1. Idempotency
    const existing = await db
      .from("workflow_events")
      .select("id, metadata")
      .eq("request_id", request.id)
      .eq("event_type", "workflow_initialized")
      .limit(1);
    if (!existing.error && existing.data?.length) {
      return {
        mode:
          ((existing.data[0].metadata as { mode?: WorkflowMode } | null)?.mode as WorkflowMode) ??
          "simulated",
        alreadyInitialized: true,
        attempts: 0,
        routedTo: request.routed_to ?? "",
        message: "Workflow was already started for this request.",
      };
    }

    // 2. Server-side routing
    const routing = routeRequest({
      fundingSource: request.funding_source,
      amount: Number(request.amount),
      priority: request.priority,
      neededBy: request.needed_by,
      today: new Date(request.created_at),
    });
    if (request.routed_to !== routing.primaryLabel || !request.metadata?.routing) {
      await db
        .from("financial_requests")
        .update({
          routed_to: routing.primaryLabel,
          metadata: { ...(request.metadata ?? {}), routing },
        })
        .eq("id", request.id);
    }

    // 3. Send to Power Automate
    const flowUrl = process.env.POWER_AUTOMATE_FLOW_URL;
    const payload = buildFlowPayload(request, routing, process.env.APP_BASE_URL);
    const chain = routing.approvalChain.map((step) => step.label);

    let mode: WorkflowMode;
    let attempts = 0;
    let eventMeta: Record<string, unknown>;
    let message: string;

    if (!flowUrl) {
      mode = "simulated";
      message = `Workflow simulated. Routed to ${routing.primaryLabel}.`;
      eventMeta = { reason: "POWER_AUTOMATE_FLOW_URL is not set" };
    } else {
      const result = await postToFlow(payload, {
        url: flowUrl,
        secret: process.env.POWER_AUTOMATE_SHARED_SECRET,
        idempotencyKey: request.id,
      });
      attempts = result.attempts;
      if (result.ok) {
        mode = "power_automate";
        message = `Power Automate workflow started. Routed to ${routing.primaryLabel}.`;
        eventMeta = { httpStatus: result.httpStatus, runId: result.runId };
      } else {
        mode = "failed";
        message = `Request saved, but Power Automate did not accept it: ${result.error}`;
        eventMeta = { httpStatus: result.httpStatus, error: result.error };
      }
    }

    // 4. Record the outcome. The flow URL is never stored.
    await db.from("workflow_events").insert({
      request_id: request.id,
      actor_user_id: context.userId,
      event_type: mode === "failed" ? "workflow_failed" : "workflow_initialized",
      message,
      metadata: {
        mode,
        connector: "power_automate",
        attempts,
        schemaVersion: payload.schemaVersion,
        requestNumber: request.request_number,
        approvalChain: chain,
        flags: routing.flags,
        ...eventMeta,
      },
    });

    if (mode !== "failed") {
      await db
        .from("financial_requests")
        .update({ workflow_triggered_at: new Date().toISOString() })
        .eq("id", request.id);
    }

    return {
      mode,
      alreadyInitialized: false,
      attempts,
      routedTo: routing.primaryLabel,
      message,
    };
  });
