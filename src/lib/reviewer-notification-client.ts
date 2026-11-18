import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import type { ReviewerNotification } from "./reviewer-notifications";

// Optional, unapplied F10 schema: same client/session, never edit generated types.
type ReviewerDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      reviewer_notifications: {
        Row: ReviewerNotification;
        Insert: never;
        Update: { read_at?: string | null };
        Relationships: [];
      };
    };
  };
};

export const reviewerNotificationClient = supabase as unknown as SupabaseClient<ReviewerDatabase>;