// Submission service for financial requests.
//
// Owns everything that happens after the form passes client validation:
// routing, building the database row, saving it (with the prototype
// fallback), uploading attachments, and starting the workflow. It never
// touches React state or the DOM, so the submit page only has to render the
// outcome.

import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";
import { isTransientBackendError, wait } from "@/lib/backend-errors";
import {
  savePrototypeAttachments,
  savePrototypeRequest,
  type SavedRequest,
} from "@/lib/prototype-store";
import { routeRequest, type RoutingDecision } from "@/lib/routing/engine";
import type { FormErrors, RequestInput } from "@/lib/validation/request-schema";
import {
  buildValidatedPayload,
  isDatabaseValidationError,
  mapDatabaseValidationError,
} from "@/lib/validation/gateways";
import { initializeWorkflow, type WorkflowMode } from "@/lib/workflow/initialize-workflow";

export type SubmissionResult = {
  id: string;
  createdAt: string;
  routedTo: string;
  routing: RoutingDecision;
  workflow: string;
  warning?: string;
};

export type SubmissionOutcome =
  | { kind: "submitted"; result: SubmissionResult }
  | { kind: "field_errors"; errors: FormErrors; message?: string };

const workflowModeLabel: Record<WorkflowMode, string> = {
  power_automate: "Started in Power Automate",
  simulated: "Simulated (flow not connected)",
  failed: "Not started",
};

// Insert retries: 6 attempts, exponential backoff from 800ms capped at 8s.
const INSERT_ATTEMPTS = 6;
const insertBackoffMs = (attempt: number) => Math.min(800 * 2 ** attempt, 8000);

// The payload is built as a loose Record<string, unknown>, which the generated
// Insert types reject, so the client stays untyped here as it was before this
// refactor. Typing the payload is tracked in DEBT_AND_RISK.md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const createRequestNumber = () => {
  const year = new Date().getFullYear();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FR-${year}-${suffix}`;
};

/** User-facing message for an unexpected submission failure. */
export const getSubmitErrorMessage = (error: unknown) => {
  if (isTransientBackendError(error)) {
    return "The request could not be saved because the backend was temporarily unavailable. Please try again in a moment.";
  }
  return error instanceof Error
    ? error.message
    : "Submission failed. Please review the required fields and try again.";
};

const getPrototypeFallbackReason = (error: unknown) => {
  if (isTransientBackendError(error)) {
    return "The hosted backend was temporarily unavailable.";
  }
  return error instanceof Error ? error.message : "The hosted backend rejected the request.";
};

/**
 * Inserts the request row. Retries transient errors, and on a duplicate
 * request number (23505) returns the row that already exists, so a retried
 * insert that actually succeeded is not reported as a failure.
 */
async function insertFinancialRequest(
  payload: Record<string, unknown>,
  requestNumber: string,
): Promise<SavedRequest> {
  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("financial_requests")
      .insert(payload)
      .select("id, request_number, created_at")
      .single();

    if (!error) return data;

    if (error.code === "23505") {
      const existing = await db
        .from("financial_requests")
        .select("id, request_number, created_at")
        .eq("request_number", requestNumber)
        .maybeSingle();
      if (!existing.error && existing.data) return existing.data;
    }

    if (attempt < INSERT_ATTEMPTS - 1 && isTransientBackendError(error)) {
      await wait(insertBackoffMs(attempt));
      continue;
    }

    throw error;
  }

  throw new Error("Submission failed. Please try again.");
}

/**
 * Uploads each file and links it to the request. Returns a warning when any
 * file could not be stored or linked, or an empty string when all succeeded.
 */
async function uploadAttachments(
  requestId: string,
  userId: string,
  files: File[],
): Promise<string> {
  let warning = "";
  try {
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = `${userId}/${requestId}/${Date.now()}-${safeName}`;
      const upload = await db.storage
        .from("request-attachments")
        .upload(path, file, { upsert: false });
      if (upload.error) {
        logger.error("attachment.upload_failed", {
          requestId,
          fileName: file.name,
          error: upload.error,
        });
        warning ||=
          "Your request was saved, but one or more attachments could not be uploaded, so attachment storage was simulated.";
        continue;
      }
      const attachment = await db.from("request_attachments").insert({
        request_id: requestId,
        user_id: userId,
        file_name: file.name,
        file_path: path,
        file_size: file.size,
        content_type: file.type,
      });
      if (attachment.error) {
        logger.error("attachment.link_failed", {
          requestId,
          fileName: file.name,
          error: attachment.error,
        });
        warning ||=
          "Your request was saved, but one or more attachments could not be linked, so attachment tracking was simulated.";
      }
    }
  } catch (error) {
    logger.error("attachment.storage_unavailable", {
      requestId,
      fileCount: files.length,
      error,
    });
    savePrototypeAttachments(requestId, userId, files);
    warning ||=
      "Your request was saved, but attachment storage is not connected right now, so attachments were simulated.";
  }
  return warning;
}

/**
 * F7: starts the Power Automate workflow on the server. The server re-checks
 * routing and records the outcome in workflow_events.
 */
async function startWorkflow(
  requestId: string,
  fallbackRoutedTo: string,
): Promise<{ workflowLabel: string; routedTo: string; warning: string }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("No active session");
    const workflow = await initializeWorkflow({
      data: { requestId },
      headers: { Authorization: `Bearer ${token}` },
    });
    const routedTo = workflow.routedTo || fallbackRoutedTo;
    const workflowLabel = workflowModeLabel[workflow.mode];
    if (workflow.mode === "failed") {
      logger.error("workflow.start_failed", { requestId, message: workflow.message });
      return { workflowLabel, routedTo, warning: workflow.message };
    }
    logger.info("workflow.started", {
      requestId,
      mode: workflow.mode,
      alreadyInitialized: workflow.alreadyInitialized,
    });
    return { workflowLabel, routedTo, warning: "" };
  } catch (error) {
    logger.error("workflow.call_failed", { requestId, error });
    return {
      workflowLabel: workflowModeLabel.failed,
      routedTo: fallbackRoutedTo,
      warning:
        "Your request was saved, but the workflow could not be started. It can be retried without resubmitting.",
    };
  }
}

/**
 * Saves a validated request and runs its follow-up steps. Field-level
 * problems come back as `field_errors`; unexpected failures are thrown so
 * the caller can show a general error.
 */
export async function submitFinancialRequest(params: {
  input: RequestInput;
  userId: string;
  files: File[];
}): Promise<SubmissionOutcome> {
  const { input, userId, files } = params;

  // F8: decide the queue and approval chain from the validated input
  const routing = routeRequest(input);
  const routedTo = routing.primaryLabel;
  const requestNumber = createRequestNumber();
  const createdAt = new Date().toISOString();

  // F22 gateway 2: normalize and re-check the row before it leaves the browser
  const payloadResult = buildValidatedPayload(
    input,
    { userId, requestNumber },
    {
      routed_to: routedTo,
      metadata: {
        source: "FinReq portal",
        automation: "Power Automate",
        attachmentCount: files.length,
        routing,
      },
    },
  );
  if (!payloadResult.ok) {
    return { kind: "field_errors", errors: payloadResult.errors };
  }
  const requestPayload = payloadResult.data;

  // Only the first warning is shown, so each step adds one only if none exists.
  let warning = "";
  let inserted: SavedRequest;

  try {
    inserted = await insertFinancialRequest(requestPayload, requestNumber);
  } catch (error) {
    // F22 gateway 3: the database rejected the data. Show the field error
    // instead of silently saving an invalid request in prototype mode.
    if (isDatabaseValidationError(error)) {
      logger.warn("request.rejected_by_database", { requestNumber, error });
      return {
        kind: "field_errors",
        errors: mapDatabaseValidationError(error) ?? {},
        message: "The server rejected one or more fields. Review the highlighted fields.",
      };
    }
    logger.error("request.insert_failed_prototype_fallback", { requestNumber, error });
    inserted = savePrototypeRequest(requestPayload, requestNumber, createdAt);
    savePrototypeAttachments(inserted.id, userId, files);
    const reason = getPrototypeFallbackReason(error);
    warning = `Saved in prototype mode. ${reason} Attachments and workflow were simulated.`;
  }

  let workflowLabel = "Simulated (prototype mode)";
  let finalRoutedTo = routedTo;

  if (!inserted.prototype) {
    warning ||= await uploadAttachments(inserted.id, userId, files);

    const workflow = await startWorkflow(inserted.id, routedTo);
    workflowLabel = workflow.workflowLabel;
    finalRoutedTo = workflow.routedTo;
    warning ||= workflow.warning;
  }

  logger.info("request.submitted", {
    requestNumber: inserted.request_number,
    prototype: !!inserted.prototype,
    attachments: files.length,
    routedTo: finalRoutedTo,
  });

  return {
    kind: "submitted",
    result: {
      id: inserted.request_number,
      createdAt: inserted.created_at,
      routedTo: finalRoutedTo,
      routing,
      workflow: workflowLabel,
      warning,
    },
  };
}
