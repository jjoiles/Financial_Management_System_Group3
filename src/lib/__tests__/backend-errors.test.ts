import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientBackendError, withTransientRetry } from "../backend-errors";

describe("isTransientBackendError", () => {
  it("matches PostgREST startup codes and 503", () => {
    expect(isTransientBackendError({ code: "PGRST000" })).toBe(true);
    expect(isTransientBackendError({ code: "PGRST002" })).toBe(true);
    expect(isTransientBackendError({ status: 503 })).toBe(true);
  });

  it("matches known transient messages, including both drifted copies", () => {
    expect(isTransientBackendError({ message: "Could not query the schema cache" })).toBe(true);
    expect(isTransientBackendError({ details: "no connection to the server" })).toBe(true);
    // Previously only the submit.tsx copy checked this.
    expect(isTransientBackendError({ message: "Database is in recovery mode" })).toBe(true);
  });

  it("is null-safe and rejects permanent errors", () => {
    // Previously only the auth-context.tsx copy handled null.
    expect(isTransientBackendError(null)).toBe(false);
    expect(isTransientBackendError(undefined)).toBe(false);
    expect(isTransientBackendError({ code: "23514", message: "check constraint" })).toBe(false);
  });
});

describe("withTransientRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient error with linear delays, then returns success", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: "PGRST001" } })
      .mockResolvedValueOnce({ error: { code: "PGRST001" } })
      .mockResolvedValueOnce({ data: "ok", error: null });

    const promise = withTransientRetry(operation);
    await vi.advanceTimersByTimeAsync(700); // 1st retry
    await vi.advanceTimersByTimeAsync(1400); // 2nd retry
    await expect(promise).resolves.toEqual({ data: "ok", error: null });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("stops after 4 attempts and returns the last error", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue({ error: { status: 503 } });
    const promise = withTransientRetry(operation);
    await vi.advanceTimersByTimeAsync(700 + 1400 + 2100);
    await expect(promise).resolves.toEqual({ error: { status: 503 } });
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("does not retry permanent errors", async () => {
    const operation = vi.fn().mockResolvedValue({ error: { code: "42501" } });
    await withTransientRetry(operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
