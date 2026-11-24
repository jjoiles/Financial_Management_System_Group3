import { createServerFn } from "@tanstack/react-start";

import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { runInitializeWorkflow } from "./run-initialize-workflow";

export type { InitializeWorkflowResult, WorkflowMode } from "./run-initialize-workflow";

// F7: Power Automate Workflow Initialization. The logic lives in
// run-initialize-workflow.ts so it can be tested without the server-function
// build step; this file only adds auth and input validation.
export const initializeWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ requestId: z.string().uuid() }))
  .handler(({ data, context }) =>
    runInitializeWorkflow(context.supabase, context.userId, data.requestId),
  );
