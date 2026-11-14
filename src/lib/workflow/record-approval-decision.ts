import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { logger } from "@/lib/logger";

export type ApprovalDecision = "approve" | "reject";

export type ApprovalDecisionResult = {
  requestId: string;
  stageId: string;
  stageOrder: number;
  decision: ApprovalDecision;
  requestStatus: "submitted" | "under_review" | "approved" | "rejected" | "completed";
  nextStageId: string | null;
  nextStageOrder: number | null;
  nextQueueId: string | null;
  finalStage: boolean;
};

const approvalDecisionSchema = z.object({
  requestId: z.string().uuid(),
  stageId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(2000).nullable().optional(),
});

export const recordApprovalDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(approvalDecisionSchema)
  .handler(async ({ data, context }): Promise<ApprovalDecisionResult> => {
    const db = context.supabase;

    // The database function is not yet in the generated Database types.
    // This typed wrapper will be removable after the types are regenerated.
    const rpc = db.rpc as unknown as (
      functionName: string,
      args: {
        _request_id: string;
        _stage_id: string;
        _decision: ApprovalDecision;
        _comment: string | null;
      },
    ) => Promise<{
      data: ApprovalDecisionResult | null;
      error: { message: string } | null;
    }>;

    const { data: result, error } = await rpc.call(db, "f16_record_approval_decision", {
      _request_id: data.requestId,
      _stage_id: data.stageId,
      _decision: data.decision,
      _comment: data.comment ?? null,
    });

    if (error) {
      logger.error("workflow.approval_decision_failed", {
        requestId: data.requestId,
        stageId: data.stageId,
        decision: data.decision,
        userId: context.userId,
        error: error.message,
      });

      throw new Error(`Could not record approval decision: ${error.message}`);
    }

    if (!result) {
      throw new Error("The approval decision returned no result.");
    }

    logger.info("workflow.approval_decision_recorded", {
      requestId: result.requestId,
      stageId: result.stageId,
      decision: result.decision,
      requestStatus: result.requestStatus,
      nextStageId: result.nextStageId,
      userId: context.userId,
    });

    return result;
  });
