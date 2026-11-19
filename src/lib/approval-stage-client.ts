import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

// The F16 feature-branch migration defines this optional table, but it is not
// installed on every backend yet. Preserve its typed read contract without
// editing generated types or creating a second client/session. Missing-table
// errors still go through the existing callers' error handling.
export type ApprovalStageRow = {
  id: string;
  request_id: string;
  // Added by the F19.2 migration (NOT NULL, default 1). Selecting it fails on
  // a backend without F19.2; callers must surface that error, not hide it.
  workflow_revision: number;
  stage_order: number;
  queue_id: string;
  stage_name: string;
  started_at: string;
  deadline_at: string;
  completed_at: string | null;
  duration_hours: number;
  status: string;
};

type WorkflowDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      approval_stage_tracking: {
        Row: ApprovalStageRow;
        Insert: ApprovalStageRow;
        Update: Partial<ApprovalStageRow>;
        Relationships: [];
      };
    };
  };
};

export const approvalStageClient = supabase as unknown as SupabaseClient<WorkflowDatabase>;
