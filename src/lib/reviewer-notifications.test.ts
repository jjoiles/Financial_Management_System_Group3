import { describe, expect, it, vi } from "vitest";
import { createReviewerNotificationService, linkedAuthorizedRequest, reviewerNotificationError,
  validRequestLink, visibleReviewerNotifications, type ReviewerNotification } from "./reviewer-notifications";

const requestId = "12345678-1234-1234-1234-123456789abc";
const row: ReviewerNotification = {
  id: "alert-1", event_id: "event-1", request_id: requestId, recipient_user_id: "reviewer",
  request_number: "FR-2026-F10", reason: "submitted", created_at: "2026-11-18T07:35:00Z", read_at: null,
};
const setup = () => {
  const authorized = vi.fn().mockResolvedValue(true);
  const read = vi.fn().mockResolvedValue([row]);
  const setRead = vi.fn().mockResolvedValue(undefined);
  return { authorized, read, setRead, service: createReviewerNotificationService({ authorized, read, setRead }) };
};
describe("F10 private reviewer notification application contract", () => {
  it("loads only after server reviewer authorization", async () => {
    const { service, authorized, read } = setup();
    expect(await service.load("reviewer")).toEqual({ authorized: true, rows: [row] });
    expect(authorized).toHaveBeenCalledWith("reviewer", undefined);
    expect(read).toHaveBeenCalledWith("reviewer", undefined);
  });
  it("skips the optional table when no authorized reviewer role exists", async () => {
    const { service, authorized, read } = setup(); authorized.mockResolvedValue(false);
    expect(await service.load("requester")).toEqual({ authorized: false, rows: [] });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([undefined, ""])("blocks signed-out reads %s", async userId => {
    const { service, authorized, read } = setup();
    await expect(service.load(userId)).rejects.toThrow("Sign in");
    expect(authorized).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("blocks reads while MFA is required", async () => {
    const { service, authorized } = setup(); await expect(service.load("reviewer", true)).rejects.toThrow("verification");
    expect(authorized).not.toHaveBeenCalled();
  });
  it("rejects authorization failures without querying alerts", async () => {
    const { service, authorized, read } = setup(); authorized.mockRejectedValue({ code: "42501" });
    await expect(service.load("reviewer")).rejects.toEqual({ code: "42501" }); expect(read).not.toHaveBeenCalled();
  });
  it.each(["42P01", "PGRST205"])("reports missing schema %s without pretending delivery", async code => {
    const { service, read } = setup(); read.mockRejectedValue({ code });
    await expect(service.load("reviewer")).rejects.toEqual({ code });
    expect(reviewerNotificationError({ code })).toContain("not enabled yet");
  });
  it("reports denied access distinctly", () => {
    expect(reviewerNotificationError({ code: "42501" })).toContain("Access restricted");
  });
  it("reports unavailable service without changing requester updates", () => {
    expect(reviewerNotificationError(new Error("offline"))).toContain("Requests and requester updates are unchanged");
  });
  it("deduplicates a persisted event/recipient even with different alert IDs", () => {
    expect(visibleReviewerNotifications([row, { ...row, id: "duplicate" }], "reviewer")).toEqual([row]);
  });
  it("keeps a later genuine attention event for the same request", () => {
    const next = { ...row, id: "alert-2", event_id: "event-2", reason: "under_review" as const };
    expect(visibleReviewerNotifications([row, next], "reviewer")).toEqual([row, next]);
  });
  it("drops foreign recipients and malformed links", () => {
    expect(visibleReviewerNotifications([row, { ...row, recipient_user_id: "other" }, { ...row, request_id: "https://external.example" }], "reviewer")).toEqual([row]);
  });
  it("does not invent alerts for empty reads", async () => {
    const { service, read } = setup(); read.mockResolvedValue([]);
    expect((await service.load("reviewer")).rows).toEqual([]);
  });
  it("marks read through a recipient-scoped write", async () => {
    const { service, setRead } = setup(); await service.setRead(row, true, "reviewer");
    expect(setRead).toHaveBeenCalledWith(row.id, "reviewer", expect.any(String), undefined);
    expect(row.read_at).toBeNull();
  });
  it("marks unread using only a null read timestamp", async () => {
    const { service, setRead } = setup(); await service.setRead({ ...row, read_at: row.created_at }, false, "reviewer");
    expect(setRead).toHaveBeenCalledWith(row.id, "reviewer", null, undefined);
  });
  it("does not repeat an unchanged read state", async () => {
    const { service, setRead } = setup(); await service.setRead(row, false, "reviewer"); expect(setRead).not.toHaveBeenCalled();
  });
  it.each([undefined, "other"])("blocks foreign/signed-out state changes %s", async userId => {
    const { service, setRead } = setup(); await expect(service.setRead(row, true, userId)).rejects.toThrow("cannot update");
    expect(setRead).not.toHaveBeenCalled();
  });
  it("blocks state changes pending MFA", async () => {
    const { service, setRead } = setup(); await expect(service.setRead(row, true, "reviewer", true)).rejects.toThrow("verification");
    expect(setRead).not.toHaveBeenCalled();
  });
  it("rechecks role revocation before a state change", async () => {
    const { service, authorized, setRead } = setup(); await service.load("reviewer"); authorized.mockResolvedValue(false);
    await expect(service.setRead(row, true, "reviewer")).rejects.toThrow("cannot update"); expect(setRead).not.toHaveBeenCalled();
  });
  it("propagates failed writes without mutating alerts", async () => {
    const { service, setRead } = setup(); setRead.mockRejectedValue(new Error("write failed"));
    await expect(service.setRead(row, true, "reviewer")).rejects.toThrow("write failed"); expect(row.read_at).toBeNull();
  });
  it("cancels before any server operation", async () => {
    const { service, authorized } = setup(); const controller = new AbortController(); controller.abort();
    await expect(service.load("reviewer", false, controller.signal)).rejects.toThrow("cancelled"); expect(authorized).not.toHaveBeenCalled();
  });
  it("cancels after authorization before reading the next identity's feed", async () => {
    const { service, authorized, read } = setup(); const controller = new AbortController();
    authorized.mockImplementation(async () => { controller.abort(); return true; });
    await expect(service.load("reviewer", false, controller.signal)).rejects.toThrow("cancelled"); expect(read).not.toHaveBeenCalled();
  });
  it("rejects late cancelled read responses", async () => {
    const { service, read } = setup(); const controller = new AbortController();
    read.mockImplementation(async () => { controller.abort(); return [row]; });
    await expect(service.load("reviewer", false, controller.signal)).rejects.toThrow("cancelled");
  });
  it.each(["https://external.example", "javascript:alert(1)", "../../private", "invalid", null])("rejects unsafe request selector %s", value => {
    expect(validRequestLink(value)).toBeUndefined();
  });
  it("accepts a UUID without granting any access", () => { expect(validRequestLink(requestId)).toBe(requestId); });
  it("links only an authorized persisted request without reordering source rows", () => {
    const rows = [{ uuid: "other", prototype: false }, { uuid: requestId, prototype: false }];
    expect(linkedAuthorizedRequest(rows, requestId, false)).toBe(rows[1]);
    expect(rows.map(item => item.uuid)).toEqual(["other", requestId]);
  });
  it("suppresses links on denied/unavailable/loading/signed-out reads", () => {
    expect(linkedAuthorizedRequest([{ uuid: requestId, prototype: false }], requestId, true)).toBeNull();
  });
  it("does not use prototype or hidden requests as reviewer-link targets", () => {
    expect(linkedAuthorizedRequest([{ uuid: requestId, prototype: true }], requestId, false)).toBeNull();
    expect(linkedAuthorizedRequest([], requestId, false)).toBeNull();
  });
});