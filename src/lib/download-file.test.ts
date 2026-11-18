import { afterEach, expect, it, vi } from "vitest";
import { downloadBlob } from "./download-file";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("starts a download synchronously and releases the URL only after 30 seconds", () => {
  vi.useFakeTimers();
  const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  const appendChild = vi.fn();
  const createObjectURL = vi.fn(() => "blob:export");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("document", { createElement: () => link, body: { appendChild } });
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const blob = new Blob(["csv"], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "requests.csv");
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(link.download).toBe("requests.csv");
  expect(link.href).toBe("blob:export");
  expect(link.click).toHaveBeenCalledOnce();
  expect(link.remove).toHaveBeenCalledOnce();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(30_000);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
});

it("propagates delivery failures and still cleans up", () => {
  vi.useFakeTimers();
  const remove = vi.fn();
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ click: () => { throw new Error("Download blocked"); }, remove }), body: { appendChild: vi.fn() } });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:failed", revokeObjectURL });
  expect(() => downloadBlob(new Blob(["csv"]), "requests.csv")).toThrow("Download blocked");
  expect(remove).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed");
});