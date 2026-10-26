// Browser-only fallback storage used when the hosted backend rejects a write.
//
// The submit flow writes here and the requests list reads from here, so the
// storage keys and record shapes live in one place. See DEBT_AND_RISK.md for
// why this fallback exists and the plan to remove it.

import { logger } from "@/lib/logger";

export const PROTOTYPE_REQUESTS_KEY = "prototype-financial-requests";
export const PROTOTYPE_ATTACHMENTS_KEY = "prototype-request-attachments";

const MAX_PROTOTYPE_REQUESTS = 50;
const MAX_PROTOTYPE_ATTACHMENTS = 100;

export type SavedRequest = {
  id: string;
  request_number: string;
  created_at: string;
  prototype?: boolean;
};

/** Reads saved prototype requests. Corrupt storage is logged and treated as empty. */
export function readPrototypeRequests<T>(): T[] {
  try {
    return JSON.parse(window.localStorage.getItem(PROTOTYPE_REQUESTS_KEY) ?? "[]");
  } catch (error) {
    logger.warn("prototype_store.corrupt", { key: PROTOTYPE_REQUESTS_KEY, error });
    return [];
  }
}

export function savePrototypeRequest(
  payload: Record<string, unknown>,
  requestNumber: string,
  createdAt: string,
): SavedRequest {
  const savedRequest = {
    ...payload,
    id: crypto.randomUUID(),
    request_number: requestNumber,
    created_at: createdAt,
    prototype: true,
  };
  const existing = JSON.parse(
    window.localStorage.getItem(PROTOTYPE_REQUESTS_KEY) ?? "[]",
  ) as unknown[];
  window.localStorage.setItem(
    PROTOTYPE_REQUESTS_KEY,
    JSON.stringify([savedRequest, ...existing].slice(0, MAX_PROTOTYPE_REQUESTS)),
  );
  return savedRequest;
}

export function savePrototypeAttachments(requestId: string, userId: string, attachments: File[]) {
  if (attachments.length === 0) return;
  const records = attachments.map((file) => ({
    id: crypto.randomUUID(),
    request_id: requestId,
    user_id: userId,
    file_name: file.name,
    file_path: `prototype://${requestId}/${file.name}`,
    file_size: file.size,
    content_type: file.type,
    created_at: new Date().toISOString(),
  }));
  const existing = JSON.parse(
    window.localStorage.getItem(PROTOTYPE_ATTACHMENTS_KEY) ?? "[]",
  ) as unknown[];
  window.localStorage.setItem(
    PROTOTYPE_ATTACHMENTS_KEY,
    JSON.stringify([...records, ...existing].slice(0, MAX_PROTOTYPE_ATTACHMENTS)),
  );
}
