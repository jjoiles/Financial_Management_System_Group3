// F5: structured application logger.
//
// Replaces silent catch blocks. Every entry has a level, an event name, a
// timestamp, and a context object. Entries go to the console (browser devtools
// or Cloudflare Worker logs) and to a small in-memory buffer. Sinks can be
// added later, e.g. Sentry, without changing call sites:
//
//   addLogSink((entry) => { if (entry.level === "error") Sentry.captureMessage(entry.event) });

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  level: LogLevel;
  event: string;
  at: string;
  context: Record<string, unknown>;
};

type Sink = (entry: LogEntry) => void;

const BUFFER_SIZE = 100;
const buffer: LogEntry[] = [];
const sinks = new Set<Sink>();

const SENSITIVE_KEY =
  /pass(word)?|token|secret|authorization|api[-_]?key|cookie|signature|flow_?url/i;

const isDev = (() => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err && typeof err === "object") {
    const { code, message, details, hint, status } = err as Record<string, unknown>;
    return { code, message, details, hint, status };
  }
  return { message: String(err) };
}

// Replaces values of sensitive keys and converts errors so entries are safe
// to print and to ship to a monitoring service.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const entry: LogEntry = {
    level,
    event,
    at: new Date().toISOString(),
    context: redact(context) as Record<string, unknown>,
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  if (level !== "debug" || isDev) {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(`[finreq] ${event}`, entry.context);
  }

  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // A broken sink must never break the app.
    }
  }
  return entry;
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => write("debug", event, context),
  info: (event: string, context?: Record<string, unknown>) => write("info", event, context),
  warn: (event: string, context?: Record<string, unknown>) => write("warn", event, context),
  error: (event: string, context?: Record<string, unknown>) => write("error", event, context),
};

export const getRecentLogs = () => [...buffer];

export function addLogSink(sink: Sink) {
  sinks.add(sink);
  return () => sinks.delete(sink);
}
