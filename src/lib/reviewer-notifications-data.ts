import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./auth-context";
import { reviewerNotificationClient } from "./reviewer-notification-client";
import { createReviewerNotificationService, reviewerNotificationError, type ReviewerNotification } from "./reviewer-notifications";
import { startRequestStatusChecks } from "./request-status-sync";

const service = createReviewerNotificationService({
  async authorized(userId, signal) {
    let query = supabase.rpc("is_admin_or_reviewer", { _user_id: userId });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    return data === true;
  },
  async read(userId, signal) {
    let query = reviewerNotificationClient.from("reviewer_notifications")
      .select("id, event_id, request_id, recipient_user_id, request_number, reason, created_at, read_at")
      .eq("recipient_user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  },
  async setRead(id, userId, readAt, signal) {
    let query = reviewerNotificationClient.from("reviewer_notifications").update({ read_at: readAt })
      .eq("id", id).eq("recipient_user_id", userId).select("id");
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Notification could not be updated. Refresh and try again.");
  },
});

export function useReviewerNotifications() {
  const { user, needsMfa } = useAuth();
  const userId = user?.id;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const mutations = useRef(new Set<AbortController>());
  const [state, setState] = useState<{
    owner?: string; rows: ReviewerNotification[]; authorized: boolean; loading: boolean; error: string | null;
  }>({ rows: [], authorized: false, loading: false, error: null });

  const reload = useCallback(async () => {
    if (!userId || needsMfa || active.current) return false;
    const version = generation.current;
    const controller = new AbortController();
    active.current = controller;
    const current = () => generation.current === version && !controller.signal.aborted;
    try {
      const result = await service.load(userId, needsMfa, controller.signal);
      if (current()) setState({ owner: userId, ...result, loading: false, error: null });
      return true;
    } catch (error) {
      if (current()) setState({ owner: userId, rows: [], authorized: false, loading: false, error: reviewerNotificationError(error) });
      return false;
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [userId, needsMfa]);

  useEffect(() => {
    generation.current += 1;
    setState({ owner: userId, rows: [], authorized: false, loading: !!userId && !needsMfa, error: null });
    if (!userId || needsMfa) return;
    const stop = startRequestStatusChecks({
      refresh: reload, online: () => navigator.onLine, visible: () => document.visibilityState === "visible",
      report: () => {},
      every: (callback, ms) => { const id = window.setInterval(callback, ms); return () => window.clearInterval(id); },
      listen: (event, callback) => {
        const target = event === "visibilitychange" ? document : window;
        target.addEventListener(event, callback);
        return () => target.removeEventListener(event, callback);
      },
    });
    return () => {
      generation.current += 1;
      stop(); active.current?.abort(); active.current = null;
      for (const controller of mutations.current) controller.abort();
      mutations.current.clear();
    };
  }, [userId, needsMfa, reload]);

  const setRead = async (row: ReviewerNotification, read: boolean) => {
    const version = generation.current;
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      await service.setRead(row, read, userId, needsMfa, controller.signal);
      if (version === generation.current && !controller.signal.aborted) {
        // No optimistic success: update only after the recipient-scoped write succeeds.
        setState(previous => ({ ...previous, error: null, rows: previous.rows.map(item =>
          item.id === row.id ? { ...item, read_at: read ? new Date().toISOString() : null } : item) }));
      }
    } catch (error) {
      if (version === generation.current && !controller.signal.aborted) {
        setState(previous => ({ ...previous, rows: [], error: reviewerNotificationError(error) }));
      }
    } finally { mutations.current.delete(controller); }
  };
  const visible = !!userId && !needsMfa && state.owner === userId;
  return {
    notifications: visible ? state.rows : [], authorized: visible && state.authorized,
    loading: visible && state.loading, error: visible ? state.error : null, reload, setRead,
  };
}