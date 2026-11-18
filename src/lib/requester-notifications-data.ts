import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { createNotificationService, notificationReadError, type RequesterNotification } from "./requester-notifications";

const service = createNotificationService({
  async read(userId) {
    const { data, error } = await supabase.from("requester_status_notifications")
      .select("id, request_id, recipient_user_id, request_number, previous_status, new_status, created_at, read_at")
      .eq("recipient_user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
    if (error) throw error;
    return data ?? [];
  },
  async acknowledge(id, userId, readAt) {
    const { data, error } = await supabase.from("requester_status_notifications")
      .update({ read_at: readAt }).eq("id", id).eq("recipient_user_id", userId)
      .is("read_at", null).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("The notification could not be marked as read. Refresh and try again.");
  },
});

export function useRequesterNotifications() {
  const { user, needsMfa } = useAuth();
  const userId = user?.id;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [state, setState] = useState<{
    owner?: string; rows: RequesterNotification[]; loading: boolean; error: string | null;
  }>({ rows: [], loading: true, error: null });

  const reload = useCallback(async () => {
    if (!userId || needsMfa || inFlight.current) return;
    const version = generation.current;
    inFlight.current = true;
    try {
      const rows = await service.load(userId, needsMfa);
      if (version === generation.current) setState({ owner: userId, rows, loading: false, error: null });
    } catch (error) {
      if (version === generation.current) setState({ owner: userId, rows: [], loading: false, error: notificationReadError(error) });
    } finally {
      if (version === generation.current) inFlight.current = false;
    }
  }, [userId, needsMfa]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setState({ owner: userId, rows: [], loading: !!userId && !needsMfa, error: null });
    void reload();
    const refresh = () => { if (document.visibilityState === "visible") void reload(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [reload, userId, needsMfa]);

  const markRead = async (notification: RequesterNotification) => {
    const version = generation.current;
    try {
      await service.markRead(notification, userId, needsMfa);
      if (version === generation.current) await reload();
    } catch {
      if (version === generation.current) setState(current => ({ ...current, error: "Could not mark the notification as read. Please try again." }));
    }
  };

  const visible = userId && !needsMfa && state.owner === userId;
  return {
    notifications: visible ? state.rows : [], loading: visible ? state.loading : false,
    error: visible ? state.error : null, reload, markRead,
  };
}