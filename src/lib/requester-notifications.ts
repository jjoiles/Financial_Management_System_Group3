import type { Database } from "@/integrations/supabase/types";
import { classifyRequestReadError } from "@/lib/request-list";

export type RequesterNotification = Database["public"]["Tables"]["requester_status_notifications"]["Row"];
export type NotificationPorts = {
  read: (userId: string) => Promise<RequesterNotification[]>;
  acknowledge: (id: string, userId: string, readAt: string) => Promise<void>;
};

export const notificationStatusLabel: Record<RequesterNotification["new_status"], string> = {
  submitted: "Submitted", under_review: "Under Review", approved: "Approved",
  rejected: "Rejected", completed: "Completed",
};

/** Only persisted, owner-scoped rows can become alerts; never synthesize transitions in the browser. */
export function visibleNotifications(rows: RequesterNotification[], userId: string) {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (row.recipient_user_id !== userId || row.previous_status === row.new_status || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export function createNotificationService(ports: NotificationPorts) {
  return {
    async load(userId: string | undefined, needsMfa = false) {
      if (!userId || needsMfa) throw new Error("Sign in and complete verification to view notifications.");
      return visibleNotifications(await ports.read(userId), userId);
    },
    async markRead(notification: RequesterNotification, userId: string | undefined, needsMfa = false) {
      if (!userId || needsMfa || notification.recipient_user_id !== userId) {
        throw new Error("You cannot update this notification.");
      }
      if (notification.read_at) return;
      await ports.acknowledge(notification.id, userId, new Date().toISOString());
    },
  };
}

export function notificationReadError(error: unknown) {
  return classifyRequestReadError(error).kind === "access"
    ? "Access restricted. Your notifications could not be loaded."
    : "Notifications are temporarily unavailable. Your requests are unchanged.";
}