import { classifyRequestReadError } from "./request-list";

export type ReviewerNotification = {
  id: string;
  event_id: string;
  request_id: string;
  recipient_user_id: string;
  request_number: string;
  reason: "submitted" | "under_review";
  created_at: string;
  read_at: string | null;
};

export const REVIEWER_REASON_LABEL = {
  submitted: "New request submitted",
  under_review: "Review required",
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validRequestLink(value: unknown): string | undefined {
  return typeof value === "string" && uuidPattern.test(value) ? value : undefined;
}

/** A URL is only a selector, never authorization or an export dataset. */
export function linkedAuthorizedRequest<T extends { uuid: string; prototype: boolean }>(
  rows: T[], requestId: string | undefined, blocked: boolean,
): T | null {
  if (blocked || !validRequestLink(requestId)) return null;
  return rows.find(row => row.uuid === requestId && !row.prototype) ?? null;
}

export function reviewerNotificationError(error: unknown): string {
  if (classifyRequestReadError(error).kind === "access") return "Access restricted. Reviewer notifications could not be loaded.";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "42P01" || code === "PGRST205") return "Reviewer notifications are not enabled yet. Requests and requester updates are unchanged.";
  return "Reviewer notifications are temporarily unavailable. Requests and requester updates are unchanged.";
}

export function visibleReviewerNotifications(rows: ReviewerNotification[], userId: string) {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = `${row.event_id}:${row.recipient_user_id}`;
    if (row.recipient_user_id !== userId || !validRequestLink(row.request_id) ||
        !(row.reason in REVIEWER_REASON_LABEL) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ReviewerNotificationPorts = {
  authorized: (userId: string, signal?: AbortSignal) => Promise<boolean>;
  read: (userId: string, signal?: AbortSignal) => Promise<ReviewerNotification[]>;
  setRead: (id: string, userId: string, readAt: string | null, signal?: AbortSignal) => Promise<void>;
};

/** Mirrors F11's private feed pattern; generation is never a browser operation. */
export function createReviewerNotificationService(ports: ReviewerNotificationPorts) {
  async function authorize(userId: string | undefined, needsMfa: boolean, signal?: AbortSignal) {
    if (!userId || needsMfa) throw new Error("Sign in and complete verification to view notifications.");
    if (signal?.aborted) throw new Error("Notification operation cancelled.");
    const allowed = await ports.authorized(userId, signal);
    if (signal?.aborted) throw new Error("Notification operation cancelled.");
    return allowed;
  }
  return {
    async load(userId: string | undefined, needsMfa = false, signal?: AbortSignal) {
      if (!await authorize(userId, needsMfa, signal) || !userId) return { authorized: false, rows: [] };
      const rows = await ports.read(userId, signal);
      if (signal?.aborted) throw new Error("Notification operation cancelled.");
      return { authorized: true, rows: visibleReviewerNotifications(rows, userId) };
    },
    async setRead(row: ReviewerNotification, read: boolean, userId: string | undefined, needsMfa = false, signal?: AbortSignal) {
      if (!userId || row.recipient_user_id !== userId) throw new Error("You cannot update this notification.");
      if (!await authorize(userId, needsMfa, signal)) throw new Error("You cannot update this notification.");
      if (Boolean(row.read_at) === read) return;
      await ports.setRead(row.id, userId, read ? new Date().toISOString() : null, signal);
    },
  };
}