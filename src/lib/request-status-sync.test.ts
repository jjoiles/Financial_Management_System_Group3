import { describe, expect, it, vi } from "vitest";
import { startRequestStatusChecks, STATUS_CHECK_INTERVAL_MS, type StatusSyncState } from "./request-status-sync";
import { filterRequests, selectVisibleRequests, sortRequests, classifyRequestReadError } from "./request-list";

function setup(refresh = vi.fn(async () => true)) {
  const events = new Map<string, () => void>();
  const cleanups: ReturnType<typeof vi.fn>[] = [];
  const report = vi.fn<(state: StatusSyncState) => void>();
  let online = true;
  let visible = true;
  let tick = () => {};
  const stop = startRequestStatusChecks({
    refresh, report, online: () => online, visible: () => visible,
    every: (callback, ms) => {
      expect(ms).toBe(30_000); tick = callback;
      const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup;
    },
    listen: (event, callback) => {
      events.set(event, callback);
      const cleanup = vi.fn(() => events.delete(event)); cleanups.push(cleanup); return cleanup;
    },
  });
  return { refresh, report, events, stop, cleanups, tick: () => tick(),
    offline: () => { online = false; events.get("offline")?.(); },
    online: () => { online = true; events.get("online")?.(); },
    hide: () => { visible = false; events.get("visibilitychange")?.(); },
    show: () => { visible = true; events.get("visibilitychange")?.(); },
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("F9 automatic request status checks", () => {
  it("checks immediately and every 30 seconds", async () => {
    expect(STATUS_CHECK_INTERVAL_MS).toBe(30_000);
    const s = setup(); await flush(); s.tick(); await flush();
    expect(s.refresh).toHaveBeenCalledTimes(2);
    expect(s.report).toHaveBeenLastCalledWith("current"); s.stop();
  });
  it("reads changed status without creating notifications", async () => {
    let status = "submitted";
    const seen: string[] = [];
    const s = setup(vi.fn(async () => { seen.push(status); return true; }));
    await flush(); status = "approved"; s.tick(); await flush();
    expect(seen).toEqual(["submitted", "approved"]); s.stop();
  });
  it("does not overlap requests", async () => {
    let resolve: (value: boolean) => void = () => {};
    const s = setup(vi.fn(() => new Promise<boolean>(done => { resolve = done; })));
    s.tick(); s.events.get("focus")?.(); expect(s.refresh).toHaveBeenCalledTimes(1);
    resolve(true); await flush(); s.stop();
  });
  it("pauses offline and reloads on reconnect", async () => {
    const s = setup(); await flush(); s.offline(); s.tick();
    expect(s.refresh).toHaveBeenCalledTimes(1); expect(s.report).toHaveBeenLastCalledWith("offline");
    s.online(); await flush(); expect(s.refresh).toHaveBeenCalledTimes(2); s.stop();
  });
  it("pauses hidden pages and checks when visible", async () => {
    const s = setup(); await flush(); s.hide(); s.tick();
    expect(s.refresh).toHaveBeenCalledTimes(1); expect(s.report).toHaveBeenLastCalledWith("paused");
    s.show(); await flush(); expect(s.refresh).toHaveBeenCalledTimes(2); s.stop();
  });
  it("reports failed reads and recovers on the next check", async () => {
    const refresh = vi.fn(async () => false); const s = setup(refresh); await flush();
    expect(s.report).toHaveBeenLastCalledWith("error");
    refresh.mockResolvedValue(true); s.tick(); await flush();
    expect(s.report).toHaveBeenLastCalledWith("current"); s.stop();
  });
  it("handles thrown availability failures", async () => {
    const s = setup(vi.fn(async () => { throw new Error("offline"); })); await flush();
    expect(s.report).toHaveBeenLastCalledWith("error"); s.stop();
  });
  it("removes all event listeners and timers on navigation or sign-out", async () => {
    const s = setup(); await flush(); s.stop(); s.tick();
    expect(s.events.size).toBe(0); expect(s.refresh).toHaveBeenCalledTimes(1);
    for (const cleanup of s.cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("ignores completion after cleanup", async () => {
    let resolve: (value: boolean) => void = () => {};
    const s = setup(vi.fn(() => new Promise<boolean>(done => { resolve = done; })));
    s.stop(); resolve(true); await flush(); expect(s.report.mock.calls).toEqual([["checking"]]);
  });
  it("new owner scheduler can read while old owner is pending", async () => {
    const old = setup(vi.fn(() => new Promise<boolean>(() => {}))); old.stop();
    const next = setup(); await flush(); expect(next.report).toHaveBeenLastCalledWith("current"); next.stop();
  });
  it("keeps authorization failures distinct from empty results", () => {
    expect(classifyRequestReadError({ code: "42501", message: "permission denied" }).kind).toBe("access");
  });
  it("preserves owner restrictions, local-only labels, and filters after status changes", () => {
    const rows = [
      { id: "FR-1", title: "Travel", userId: "owner", prototype: false, status: "Submitted", fundingType: "Department", amount: 100, createdAt: "2026-11-18" },
      { id: "FR-2", title: "Travel", userId: "other", prototype: false, status: "Approved", fundingType: "Department", amount: 200, createdAt: "2026-11-18" },
      { id: "FR-3", title: "Local", userId: "owner", prototype: true, status: "Submitted", fundingType: "Department", amount: 300, createdAt: "2026-11-18" },
    ].map(row => ({ ...row, email: "", department: "Finance", submittedAt: "2026-11-18" })) as Array<{
      id: string; title: string; userId: string; prototype: boolean; status: "Submitted" | "Approved";
      fundingType: "Department"; amount: number; createdAt: string; email: string; department: string; submittedAt: string;
    }>;
    const visible = selectVisibleRequests(rows, "owner", true);
    expect(visible.map(row => row.id)).toEqual(["FR-1", "FR-3"]);
    const updated = visible.map(row => row.id === "FR-1" ? { ...row, status: "Approved" as const } : row);
    expect(sortRequests(filterRequests(updated, { search: "Travel", status: "Approved", scope: "tracking" }), "amount-desc").map(row => row.id)).toEqual(["FR-1"]);
    expect(updated.find(row => row.id === "FR-3")?.prototype).toBe(true);
    expect(updated.find(row => row.id === "FR-3")?.status).toBe("Submitted");
  });
});