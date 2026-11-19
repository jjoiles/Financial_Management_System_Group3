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
// 1. Loads the request as the signed-in user.
// 2. Recomputes and saves complete routing metadata.
// 3. Checks whether the workflow was already initialized.
// 4. Starts the Power Automate workflow when necessary.
// 5. Records the workflow outcome.
// 6. Starts the first approval-stage SLA timer.
//
// The initial SLA stage is created through the secure F16 database function.
// Repeated calls do not create duplicate SLA stage records.

export type WorkflowMode = "power_automate" | "simulated" | "ambiguous" | "failed";

export type InitializeWorkflowResult = {
  mode: WorkflowMode;
  alreadyInitialized: boolean;
  attempts: number;
  routedTo: string;
  message: string;
};

const REQUEST_COLUMNS =
  "id, request_number, user_id, title, requester_email, department, funding_source, amount, needed_by, priority, grant_number, principal_investigator, university_program, status, created_at, routed_to, workflow_revision, metadata";

type ClaimResult = {
  alreadyInitialized?: boolean;
  claimGranted?: boolean;
  claimToken?: string | null;
  requestRevision?: number;
  completionMode?: "power_automate" | "simulated" | "ambiguous_timeout" | "failed" | null;
};

type CompleteResult = {
  mode: "power_automate" | "simulated" | "ambiguous_timeout" | "failed";
  requestRevision: number;
  initialStageId: string | null;
  failed: boolean;
};

type DbLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
    };
  };
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function mapCompletionMode(mode: ClaimResult["completionMode"]): WorkflowMode {
  if (mode === "power_automate") return "power_automate";
  if (mode === "ambiguous_timeout") return "ambiguous";
  if (mode === "failed") return "failed";
  return "simulated";
}

export async function initializeWorkflowCore(params: {
  db: DbLike;
  requestId: string;
  userId: string;
  flowUrl?: string;
  flowSecret?: string;
  appBaseUrl?: string;
}): Promise<InitializeWorkflowResult> {
  const { db, requestId, userId, flowUrl, flowSecret, appBaseUrl } = params;

  const { data: row, error } = await db
    .from("financial_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load request: ${error.message}`);
  }

  if (!row) {
    throw new Response("Request not found", { status: 404 });
  }

  const request = row as RequestRow & {
    routed_to: string | null;
    workflow_revision: number;
    metadata: Record<string, unknown> | null;
  };

  const routing = routeRequest({
    fundingSource: request.funding_source,
    amount: Number(request.amount),
    priority: request.priority,
    neededBy: request.needed_by,
    today: new Date(request.created_at),
  });

  const savedRouting = request.metadata?.routing as
    | {
        primaryQueue?: unknown;
        primaryLabel?: unknown;
        approvalChain?: unknown;
      }
    | undefined;

  const savedApprovalChain = savedRouting?.approvalChain;

  const hasCompleteRouting =
    savedRouting?.primaryQueue === routing.primaryQueue &&
    savedRouting?.primaryLabel === routing.primaryLabel &&
    Array.isArray(savedApprovalChain) &&
    savedApprovalChain.length === routing.approvalChain.length &&
    savedApprovalChain.every((savedStep, index) => {
      if (typeof savedStep !== "object" || savedStep === null) {
        return false;
      }

      const storedStep = savedStep as {
        step?: unknown;
        queue?: unknown;
        label?: unknown;
      };

      const expectedStep = routing.approvalChain[index];

      return (
        storedStep.step === expectedStep.step &&
        storedStep.queue === expectedStep.queue &&
        storedStep.label === expectedStep.label
      );
    });

  if (request.routed_to !== routing.primaryLabel || !hasCompleteRouting) {
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

  const claimResponse = await db.rpc("f19_claim_workflow_initialization", {
    _request_id: request.id,
    _lease_seconds: 120,
  });

  if (claimResponse.error) {
    throw new Error(`Could not claim workflow initialization: ${claimResponse.error.message}`);
  }

  const claim = (claimResponse.data ?? {}) as ClaimResult;
  const routedTo = routing.primaryLabel;

  if (claim.alreadyInitialized) {
    return {
      mode: mapCompletionMode(claim.completionMode),
      alreadyInitialized: true,
      attempts: 0,
      routedTo,
      message: "Workflow was already started for this request.",
    };
  }

  if (!claim.claimGranted || !claim.claimToken || !claim.requestRevision) {
    return {
      mode: "ambiguous",
      alreadyInitialized: false,
      attempts: 0,
      routedTo,
      message: "Workflow initialization is already in progress for this request.",
    };
  }

  const payload = buildFlowPayload(request, routing, appBaseUrl);
  const idempotencyKey = `${request.id}:${claim.requestRevision}`;
  const chain = routing.approvalChain.map((step) => step.label);

  let mode: WorkflowMode;
  let completionMode: "power_automate" | "simulated" | "ambiguous_timeout" | "failed";
  let attempts = 0;
  let message: string;
  let eventMeta: Record<string, unknown>;

  if (!flowUrl) {
    mode = "simulated";
    completionMode = "simulated";
    message = `Workflow simulated. Routed to ${routedTo}.`;
    eventMeta = { reason: "POWER_AUTOMATE_FLOW_URL is not set" };
  } else {
    const flowResult = await postToFlow(payload, {
      url: flowUrl,
      secret: flowSecret,
      idempotencyKey,
    });

    attempts = flowResult.attempts;

    if (flowResult.ok) {
      mode = "power_automate";
      completionMode = "power_automate";
      message = `Power Automate workflow started. Routed to ${routedTo}.`;
      eventMeta = {
        httpStatus: flowResult.httpStatus,
        runId: flowResult.runId,
      };
    } else if (flowResult.uncertain) {
      mode = "ambiguous";
      completionMode = "ambiguous_timeout";
      message =
        "Power Automate delivery could not be confirmed due to a timeout, transport failure, or server error. Initialization was completed with an ambiguous external status.";
      eventMeta = {
        httpStatus: flowResult.httpStatus,
        error: flowResult.error,
        uncertain: true,
      };
    } else {
      mode = "failed";
      completionMode = "failed";
      message = `Request saved, but Power Automate did not accept it: ${flowResult.error}`;
      eventMeta = {
        httpStatus: flowResult.httpStatus,
        error: flowResult.error,
      };
    }
  }

  const completionResponse = await db.rpc("f19_complete_workflow_initialization", {
    _request_id: request.id,
    _claim_token: claim.claimToken,
    _mode: completionMode,
    _attempts: attempts,
    _event_message: message,
    _event_metadata: {
      mode,
      connector: "power_automate",
      attempts,
      schemaVersion: payload.schemaVersion,
      requestNumber: request.request_number,
      approvalChain: chain,
      flags: routing.flags,
      idempotencyKey,
      ...eventMeta,
    },
  });

  if (completionResponse.error) {
    throw new Error(
      `Could not complete workflow initialization: ${completionResponse.error.message}`,
    );
  }

  const complete = completionResponse.data as CompleteResult | null;
  if (!complete) {
    throw new Error("Workflow initialization completion returned no result.");
  }

  if (mode === "failed") {
    logger.error("workflow.initialization_failed", {
      requestId: request.id,
      requestNumber: request.request_number,
      attempts,
      ...eventMeta,
    });
  } else {
    logger.info("workflow.initialization_completed", {
      requestId: request.id,
      requestNumber: request.request_number,
      mode,
      requestRevision: complete.requestRevision,
      initialStageId: complete.initialStageId,
      attempts,
    });
  }

  return {
    mode,
    alreadyInitialized: false,
    attempts,
    routedTo,
    message,
  };
}

export const initializeWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ requestId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<InitializeWorkflowResult> => {
    return initializeWorkflowCore({
      db: context.supabase as unknown as DbLike,
      requestId: data.requestId,
      userId: context.userId,
      flowUrl: process.env.POWER_AUTOMATE_FLOW_URL,
      flowSecret: process.env.POWER_AUTOMATE_SHARED_SECRET,
      appBaseUrl: process.env.APP_BASE_URL,
    });
  });
