/** Browser-safe scheduler. Reads only; never writes requests or F11 notifications. */
export const STATUS_CHECK_INTERVAL_MS = 30_000;
export type StatusSyncState = "checking" | "current" | "offline" | "error" | "paused";

export function startRequestStatusChecks(options: {
  refresh: () => Promise<boolean>;
  online: () => boolean;
  visible: () => boolean;
  report: (state: StatusSyncState) => void;
  listen: (event: "online" | "offline" | "focus" | "visibilitychange", callback: () => void) => () => void;
  every: (callback: () => void, milliseconds: number) => () => void;
}) {
  let disposed = false;
  let pending = false;
  const check = async () => {
    if (disposed) return;
    if (!options.online()) { options.report("offline"); return; }
    if (!options.visible()) { options.report("paused"); return; }
    if (pending) return;
    pending = true;
    options.report("checking");
    try {
      const success = await options.refresh();
      if (!disposed) options.report(!options.online() ? "offline" : success ? "current" : "error");
    } catch {
      if (!disposed) options.report(options.online() ? "error" : "offline");
    } finally {
      pending = false;
    }
  };
  const wake = () => { void check(); };
  const stop = [
    options.every(wake, STATUS_CHECK_INTERVAL_MS),
    ...(["online", "offline", "focus", "visibilitychange"] as const).map(event => options.listen(event, wake)),
  ];
  wake();
  return () => {
    disposed = true;
    for (const cleanup of stop) cleanup();
  };
}