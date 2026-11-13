import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { logger } from "@/lib/logger";
import { routeRequest } from "@/lib/routing/engine";
import { buildFlowPayload, postToFlow, type RequestRow } from "./power-automate";

// F7: Power Automate Workflow Initialization
// F16: Initial SLA Stage Tracking
//
// Runs on the server after a request is saved. It:
//   1. Loads the request as the signed-in user.
//   2. Recomputes routing.
//   3. Starts the Power Automate workflow.
//   4. Records the workflow outcome.
//   5. Starts the first approval-stage SLA timer.
//
// The initial SLA stage is created through the secure F16 database function.
// Repeated calls do not create duplicate SLA stage records.

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

    if (error) {
      throw new Error(`Could not load request: ${error.message}`);
    }

    if (!row) {
      throw new Response("Request not found", { status: 404 });
    }

    const request = row as RequestRow & {
      routed_to: string | null;
      metadata: Record<string, unknown> | null;
    };

    // F16: Start the first approval-stage SLA timer.
    // The database function handles authorization and duplicate prevention.
    const startInitialSlaStage = async () => {
      try {
        // The F16 RPC type will be included when Supabase database types
        // are regenerated after the migration is applied.
        const rpc = db.rpc as unknown as (
          functionName: string,
          args: { _request_id: string },
        ) => Promise<{
          data: string | null;
          error: { message: string } | null;
        }>;

        const { data: stageId, error: stageError } = await rpc.call(
          db,
          "f16_start_initial_approval_stage",
          { _request_id: request.id },
        );

        if (stageError) {
          logger.error("workflow.sla_stage_start_failed", {
            requestId: request.id,
            error: stageError.message,
          });
          return;
        }

        logger.info("workflow.sla_stage_started", {
          requestId: request.id,
          stageId,
        });
      } catch (stageError) {
        logger.error("workflow.sla_stage_start_failed", {
          requestId: request.id,
          error: stageError,
        });
      }
    };

    // 1. Idempotency
    const existing = await db
      .from("workflow_events")
      .select("id, metadata")
      .eq("request_id", request.id)
      .eq("event_type", "workflow_initialized")
      .limit(1);

    if (!existing.error && existing.data?.length) {
      const previousMode =
        (existing.data[0].metadata as { mode?: WorkflowMode } | null)?.mode ?? "simulated";

      // Recover missing initial SLA tracking if workflow was already started.
      await startInitialSlaStage();

      return {
        mode: previousMode,
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
      const { error: routingError } = await db
        .from("financial_requests")
        .update({
          routed_to: routing.primaryLabel,
          metadata: { ...(request.metadata ?? {}), routing },
        })
        .eq("id", request.id);

      if (routingError) {
        throw new Error(`Could not save request routing: ${routingError.message}`);
      }
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
        eventMeta = {
          httpStatus: result.httpStatus,
          runId: result.runId,
        };
      } else {
        mode = "failed";
        message = `Request saved, but Power Automate did not accept it: ${result.error}`;
        eventMeta = {
          httpStatus: result.httpStatus,
          error: result.error,
        };
      }
    }

    const logContext = {
      requestId: request.id,
      requestNumber: request.request_number,
      mode,
      attempts,
      ...eventMeta,
    };

    if (mode === "failed") {
      logger.error("workflow.flow_rejected", logContext);
    } else {
      logger.info("workflow.initialized", logContext);
    }

    // 4. Record the workflow outcome.
    const recorded = await db.from("workflow_events").insert({
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

    if (recorded.error) {
      logger.error("workflow.event_write_failed", {
        requestId: request.id,
        error: recorded.error,
      });
    }

    // 5. Update workflow timestamp and start SLA tracking.
    if (mode !== "failed") {
      const { error: updateError } = await db
        .from("financial_requests")
        .update({ workflow_triggered_at: new Date().toISOString() })
        .eq("id", request.id);

      if (updateError) {
        logger.error("workflow.timestamp_update_failed", {
          requestId: request.id,
          error: updateError.message,
        });
      }

      await startInitialSlaStage();
    }

    return {
      mode,
      alreadyInitialized: false,
      attempts,
      routedTo: routing.primaryLabel,
      message,
    };
  });
