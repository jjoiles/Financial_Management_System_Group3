import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

// F6: reads the related-request links the database created for one request.
// RLS only returns a link when the user can see both requests.

export type LinkType = "same_grant" | "same_program" | "possible_duplicate";

export type RequestLink = {
  id: string;
  linkType: LinkType;
  reason: string;
  linked: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
};

export const linkTypeLabel: Record<LinkType, string> = {
  same_grant: "Same grant",
  same_program: "Same program",
  possible_duplicate: "Possible duplicate",
};

type LinkRow = {
  id: string;
  link_type: LinkType;
  reason: string;
  linked: {
    id: string;
    request_number: string;
    title: string;
    status: string;
  } | null;
};

// request_links is newer than the generated Database types, so it is queried
// through an untyped client until types.ts is regenerated.
const untyped = supabase as unknown as SupabaseClient;

export function useRequestLinks(requestId: string | null, enabled = true) {
  const [links, setLinks] = useState<RequestLink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!requestId || !enabled) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    untyped
      .from("request_links")
      .select(
        "id, link_type, reason, linked:financial_requests!request_links_linked_request_id_fkey(id, request_number, title, status)",
      )
      .eq("request_id", requestId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Table missing (migration not applied) or RLS error: show nothing.
          logger.warn("links.load_failed", { requestId, error });
          setLinks([]);
        } else {
          setLinks(
            ((data ?? []) as unknown as LinkRow[]).map((row) => ({
              id: row.id,
              linkType: row.link_type,
              reason: row.reason,
              linked: row.linked
                ? {
                    id: row.linked.id,
                    requestNumber: row.linked.request_number,
                    title: row.linked.title,
                    status: row.linked.status,
                  }
                : null,
            })),
          );
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, enabled]);

  return { links, loading };
}
