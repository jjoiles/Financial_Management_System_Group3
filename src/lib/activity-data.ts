import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

export type ActivityEvent = {
  id: string;
  eventType: string;
  message: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string;
  metadata: Record<string, unknown>;
};

export function useRequestActivity(requestId: string | null, enabled = true) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId || !enabled) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadActivity() {
      setLoading(true);
      setError(null);

      try {
        const { data, error: dbError } = await supabase
          .from("workflow_events")
          .select("id, event_type, message, created_at, actor_user_id, metadata")
          .eq("request_id", requestId!)
          .order("created_at", { ascending: true });

        if (cancelled) return;

        if (dbError) {
          logger.error("activity.load_failed", { requestId, error: dbError });
          setError("Activity could not be loaded.");
          setEvents([]);
          setLoading(false);
          return;
        }

        const rows = data ?? [];
        const actorIds = [
          ...new Set(
            rows.map((row) => row.actor_user_id).filter((id): id is string => id !== null),
          ),
        ];

        const actorNames = new Map<string, string>();

        if (actorIds.length > 0) {
          const { data: profiles, error: profileError } = await supabase
            .from("profiles")
            .select("user_id, display_name")
            .in("user_id", actorIds);

          if (profileError) {
            logger.error("activity.actor_lookup_failed", {
              requestId,
              error: profileError,
            });
          }

          for (const profile of profiles ?? []) {
            if (profile.display_name.trim()) {
              actorNames.set(profile.user_id, profile.display_name.trim());
            }
          }
        }

        if (cancelled) return;

        setEvents(
          rows.map((row) => ({
            id: row.id,
            eventType: row.event_type,
            message: row.message,
            createdAt: row.created_at,
            actorUserId: row.actor_user_id,
            actorName: row.actor_user_id
              ? (actorNames.get(row.actor_user_id) ?? `User (${row.actor_user_id.slice(0, 8)})`)
              : "System",
            metadata: (row.metadata ?? {}) as Record<string, unknown>,
          })),
        );
      } catch (loadError) {
        if (cancelled) return;

        logger.error("activity.load_failed", { requestId, error: loadError });
        setError("Activity could not be loaded.");
        setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadActivity();

    return () => {
      cancelled = true;
    };
  }, [requestId, enabled]);

  return { events, loading, error };
}
