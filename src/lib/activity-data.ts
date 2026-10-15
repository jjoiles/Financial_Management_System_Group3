import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

// F5: reads the automatic log (workflow_events) for one request. RLS limits
// results to requests the user can already see.

export type ActivityEvent = {
  id: string;
  eventType: string;
  message: string;
  createdAt: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
};

export function useRequestActivity(requestId: string | null, enabled = true) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId || !enabled) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase
      .from("workflow_events")
      .select("id, event_type, message, created_at, actor_user_id, metadata")
      .eq("request_id", requestId)
      .order("created_at", { ascending: true })
      .then(({ data, error: dbError }) => {
        if (cancelled) return;
        if (dbError) {
          logger.error("activity.load_failed", { requestId, error: dbError });
          setError("Activity could not be loaded.");
          setEvents([]);
        } else {
          setEvents(
            (data ?? []).map((row) => ({
              id: row.id,
              eventType: row.event_type,
              message: row.message,
              createdAt: row.created_at,
              actorUserId: row.actor_user_id,
              metadata: (row.metadata ?? {}) as Record<string, unknown>,
            })),
          );
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, enabled]);

  return { events, loading, error };
}
