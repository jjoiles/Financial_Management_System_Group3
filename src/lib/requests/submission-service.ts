import { logger } from "../logger";
import { routeRequest } from "../routing/engine";
import {
  createRequestNumber,
  generateRequestMetadataSafe,
  sanitizeFileName,
  verifyMetadataAssociation,
} from "../request-utils";
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
      const createdAt = now.toISOString();
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
        logger.error("request.insert_failed_prototype_fallback", { requestNumber, error });
        inserted = ports.savePrototypeRequest(payload.data, requestNumber, createdAt);
        ports.savePrototypeAttachments(inserted.id, userId, files);
        const reason = isTransientBackendError(error)
          ? "The hosted backend was temporarily unavailable."
          : error instanceof Error
            ? error.message
            : "The hosted backend rejected the request.";
        warning = `Saved in prototype mode. ${reason} Attachments and workflow were simulated.`;
      }

      if (!inserted.prototype) {
        try {
          for (const file of files) {
            const path = `${userId}/${inserted.id}/${ports.now().getTime()}-${sanitizeFileName(file.name)}`;
            const upload = await ports.uploadAttachment(path, file);
            if (upload.error) {
              logger.error("attachment.upload_failed", {
                requestId: inserted.id,
                fileName: file.name,
                error: upload.error,
              });
              warning ||=
                "Your request was saved, but one or more attachments could not be uploaded, so attachment storage was simulated.";
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
                "Your request was saved, but one or more attachments could not be linked, so attachment tracking was simulated.";
            }
          }
        } catch (error) {
          logger.error("attachment.storage_unavailable", {
            requestId: inserted.id,
            fileCount: files.length,
            error,
          });
          ports.savePrototypeAttachments(inserted.id, userId, files);
          warning ||=
            "Your request was saved, but attachment storage is not connected right now, so attachments were simulated.";
        }
      }

      let workflowLabel = "Simulated (prototype mode)";
      let finalRoutedTo = routedTo;
      if (!inserted.prototype) {
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
      }
      logger.info("request.submitted", {
        requestNumber: inserted.request_number,
        prototype: !!inserted.prototype,
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
