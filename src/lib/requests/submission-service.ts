import { logger } from "../logger";
import { routeRequest } from "../routing/engine";
import {
  createRequestNumber,
  generateRequestMetadataSafe,
  verifyMetadataAssociation,
} from "../request-utils";
import { buildSafeStoragePath } from "../file-validation";
import {
  buildValidatedPayload,
  isDatabaseValidationError,
  mapDatabaseValidationError,
  validateSubmission,
  type RequestPayload,
} from "../validation/gateways";
import type { WorkflowMode } from "../workflow/initialize-workflow";
import type { SavedRequest, SubmissionPorts, SubmissionService } from "./submission-types";

const workflowModeLabel: Record<WorkflowMode, string> = {
  power_automate: "Started in Power Automate",
  simulated: "Simulated (flow not connected)",
  failed: "Not started",
};

const transientBackendCodes = new Set(["PGRST000", "PGRST001", "PGRST002"]);

function isTransientBackendError(error: unknown) {
  const detail = error as {
    code?: string;
    message?: string;
    details?: string;
    status?: number;
  } | null;
  const text = `${detail?.message ?? ""} ${detail?.details ?? ""}`.toLowerCase();
  return (
    transientBackendCodes.has(detail?.code ?? "") ||
    detail?.status === 503 ||
    text.includes("schema cache") ||
    text.includes("recovery mode") ||
    text.includes("no connection")
  );
}

async function insertWithRetry(
  ports: SubmissionPorts,
  payload: RequestPayload,
  requestNumber: string,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await ports.insertRequest(payload);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        // Preserve recovery after a successful insert whose response was lost.
        const existing = await ports.findRequest(requestNumber);
        if (existing) return existing;
      }
      if (attempt < 5 && isTransientBackendError(error)) {
        await ports.wait(Math.min(800 * 2 ** attempt, 8000));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Submission failed. Please try again.");
}

/** Owns the submission use case; it has no React, Supabase, or window dependency. */
export function createSubmissionService(ports: SubmissionPorts): SubmissionService {
  return async ({ userId, values, files }) => {
    if (!userId) {
      return {
        ok: false,
        errors: {},
        message: "Please sign in before submitting a financial request.",
      };
    }
    const parsed = validateSubmission(values);
    if (!parsed.ok) return { ok: false, errors: parsed.errors, message: "" };

    try {
      const routing = routeRequest(parsed.data);
      const routedTo = routing.primaryLabel;
      const now = ports.now();
      const requestNumber = createRequestNumber(now);
      const metadata = generateRequestMetadataSafe({
        userId,
        requestNumber,
        requesterEmail: parsed.data.requesterEmail,
        department: parsed.data.department,
        fundingSource: parsed.data.fundingSource,
        amount: parsed.data.amount,
        priority: parsed.data.priority,
        neededBy: parsed.data.neededBy,
        files,
        routing,
        now,
      });
      const association = verifyMetadataAssociation(metadata, {
        userId,
        requestNumber,
        requesterEmail: parsed.data.requesterEmail,
        department: parsed.data.department,
        attachmentCount: files.length,
      });
      if (!association.linked) {
        logger.error("metadata.association_mismatch", {
          requestNumber,
          mismatches: association.mismatches,
        });
        return {
          ok: false,
          errors: {},
          message:
            "Request metadata could not be linked to your account. Please refresh and try again.",
        };
      }

      const payload = buildValidatedPayload(
        parsed.data,
        { userId, requestNumber },
        { routed_to: routedTo, metadata },
      );
      if (!payload.ok) return { ok: false, errors: payload.errors, message: "" };

      let warning = "";
      let inserted: SavedRequest;
      try {
        inserted = await insertWithRetry(ports, payload.data, requestNumber);
      } catch (error) {
        if (isDatabaseValidationError(error)) {
          logger.warn("request.rejected_by_database", { requestNumber, error });
          return {
            ok: false,
            errors: mapDatabaseValidationError(error) ?? {},
            message: "The server rejected one or more fields. Review the highlighted fields.",
          };
        }
        // No local fallback: a request that did not reach the database was not submitted.
        logger.error("request.insert_failed", { requestNumber, error });
        return {
          ok: false,
          errors: {},
          message: isTransientBackendError(error)
            ? "The request could not be saved because the backend was temporarily unavailable. Please try again in a moment."
            : "The request could not be saved. Please try again. If the problem continues, contact the FinReq team.",
        };
      }

      try {
        for (const file of files) {
          const path = buildSafeStoragePath({
            userId,
            requestId: inserted.id,
            fileName: file.name,
            timestampMs: ports.now().getTime(),
          });
          const upload = await ports.uploadAttachment(path, file);
          if (upload.error) {
            logger.error("attachment.upload_failed", {
              requestId: inserted.id,
              fileName: file.name,
              error: upload.error,
            });
            warning ||=
              "Your request was saved, but one or more attachments could not be uploaded.";
            continue;
          }
          const attachment = await ports.linkAttachment({
            request_id: inserted.id,
            user_id: userId,
            file_name: file.name,
            file_path: path,
            file_size: file.size,
            content_type: file.type,
          });
          if (attachment.error) {
            logger.error("attachment.link_failed", {
              requestId: inserted.id,
              fileName: file.name,
              error: attachment.error,
            });
            warning ||=
              "Your request was saved, but one or more attachments could not be linked to it.";
          }
        }
      } catch (error) {
        logger.error("attachment.storage_unavailable", {
          requestId: inserted.id,
          fileCount: files.length,
          error,
        });
        warning ||=
          "Your request was saved, but attachment storage is not available right now, so attachments were not uploaded.";
      }

      let workflowLabel: string = workflowModeLabel.failed;
      let finalRoutedTo = routedTo;
      try {
        const workflow = await ports.startWorkflow(inserted.id);
        finalRoutedTo = workflow.routedTo || routedTo;
        workflowLabel = workflowModeLabel[workflow.mode];
        if (workflow.mode === "failed") {
          logger.error("workflow.start_failed", {
            requestId: inserted.id,
            message: workflow.message,
          });
          warning ||= workflow.message;
        } else {
          logger.info("workflow.started", {
            requestId: inserted.id,
            mode: workflow.mode,
            alreadyInitialized: workflow.alreadyInitialized,
          });
        }
      } catch (error) {
        logger.error("workflow.call_failed", { requestId: inserted.id, error });
        workflowLabel = workflowModeLabel.failed;
        warning ||=
          "Your request was saved, but the workflow could not be started. It can be retried without resubmitting.";
      }
      logger.info("request.submitted", {
        requestNumber: inserted.request_number,
        attachments: files.length,
        routedTo: finalRoutedTo,
      });
      return {
        ok: true,
        result: {
          id: inserted.request_number,
          createdAt: inserted.created_at,
          routedTo: finalRoutedTo,
          routing,
          workflow: workflowLabel,
          warning,
        },
      };
    } catch (error) {
      logger.error("request.submit_failed", { error });
      return {
        ok: false,
        errors: {},
        message: isTransientBackendError(error)
          ? "The request could not be saved because the backend was temporarily unavailable. Please try again in a moment."
          : error instanceof Error
            ? error.message
            : "Submission failed. Please review the required fields and try again.",
      };
    }
  };
}
