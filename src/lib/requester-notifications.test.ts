import { describe, expect, it, vi } from "vitest";
import { createNotificationService, notificationReadError, notificationStatusLabel, visibleNotifications, type RequesterNotification } from "./requester-notifications";

const row: RequesterNotification = {
  id: "event-1", request_id: "request-1", recipient_user_id: "owner",
  request_number: "FR-2026-F11", previous_status: "submitted", new_status: "approved",
  created_at: "2026-11-18T06:00:00Z", read_at: null,
};
const setup = () => {
  const read = vi.fn().mockResolvedValue([row]);
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  return { read, acknowledge, service: createNotificationService({ read, acknowledge }) };
};

describe("F11 private persisted requester notifications", () => {
  it("loads a persisted successful transition only for the requester", async () => {
    const { service, read } = setup();
    expect(await service.load("owner")).toEqual([row]);
    expect(read).toHaveBeenCalledWith("owner");
  });
  it("supports persisted submission and all existing status labels", () => {
    expect(visibleNotifications([{ ...row, previous_status: null, new_status: "submitted" }], "owner")).toHaveLength(1);
    expect(notificationStatusLabel).toEqual({ submitted: "Submitted", under_review: "Under Review", approved: "Approved", rejected: "Rejected", completed: "Completed" });
  });
  it("does not display unchanged statuses", () => {
    expect(visibleNotifications([{ ...row, previous_status: "approved" }], "owner")).toEqual([]);
  });
  it("deduplicates the same persisted event but keeps repeated legitimate transitions", () => {
    expect(visibleNotifications([row, row, { ...row, id: "event-2" }], "owner").map(item => item.id)).toEqual(["event-1", "event-2"]);
  });
  it("never includes another recipient, even in an unexpected server response", () => {
    expect(visibleNotifications([row, { ...row, id: "foreign", recipient_user_id: "other" }], "owner")).toEqual([row]);
  });
  it("an empty persisted feed does not fabricate notifications from local requests", async () => {
    const { service, read } = setup(); read.mockResolvedValue([]);
    expect(await service.load("owner")).toEqual([]);
  });
  it("propagates failed reads instead of reporting successful empty delivery", async () => {
    const { service, read } = setup(); read.mockRejectedValue({ code: "42501" });
    await expect(service.load("owner")).rejects.toEqual({ code: "42501" });
    expect(notificationReadError({ code: "42501" })).toContain("Access restricted");
    expect(notificationReadError(new Error("network"))).toContain("temporarily unavailable");
  });
  it.each([undefined, ""])("blocks signed-out reads (%s)", async user => {
    const { service, read } = setup();
    await expect(service.load(user)).rejects.toThrow("Sign in"); expect(read).not.toHaveBeenCalled();
  });
  it("blocks reads pending MFA", async () => {
    const { service, read } = setup();
    await expect(service.load("owner", true)).rejects.toThrow("verification"); expect(read).not.toHaveBeenCalled();
  });
  it("acknowledges an owned alert without touching request status", async () => {
    const { service, acknowledge } = setup(); await service.markRead(row, "owner");
    expect(acknowledge).toHaveBeenCalledWith("event-1", "owner", expect.any(String));
  });
  it.each([undefined, "other"])("rejects unauthorized acknowledgments (%s)", async user => {
    const { service, acknowledge } = setup();
    await expect(service.markRead(row, user)).rejects.toThrow("cannot update"); expect(acknowledge).not.toHaveBeenCalled();
  });
  it("rejects acknowledgment pending MFA", async () => {
    const { service, acknowledge } = setup(); await expect(service.markRead(row, "owner", true)).rejects.toThrow();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("does not repeatedly acknowledge an already read alert", async () => {
    const { service, acknowledge } = setup(); await service.markRead({ ...row, read_at: row.created_at }, "owner");
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("a notification write failure propagates without mutating status or read state", async () => {
    const { service, acknowledge } = setup(); acknowledge.mockRejectedValue(new Error("write failed"));
    await expect(service.markRead(row, "owner")).rejects.toThrow("write failed");
    expect(row.new_status).toBe("approved"); expect(row.read_at).toBeNull();
  });
});