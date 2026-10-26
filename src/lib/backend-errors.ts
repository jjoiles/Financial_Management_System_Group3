// Shared helpers for classifying and retrying Supabase errors.
//
// Before this module existed, submit.tsx and auth-context.tsx each kept their
// own copy of this logic, and the two copies had drifted apart: only the
// submit copy recognized "recovery mode", and only the auth copy handled a
// null error. This single version keeps both behaviors.

// PostgREST codes returned while the API is starting up or reloading its
// schema cache. Retrying usually succeeds.
const TRANSIENT_BACKEND_CODES = new Set(["PGRST000", "PGRST001", "PGRST002"]);

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MaybeBackendError = { code?: string; message?: string; details?: string; status?: number };

/** True when a Supabase/PostgREST error is likely temporary and worth retrying. */
export function isTransientBackendError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as MaybeBackendError;
  const text = `${maybeError.message ?? ""} ${maybeError.details ?? ""}`.toLowerCase();
  return (
    TRANSIENT_BACKEND_CODES.has(maybeError.code ?? "") ||
    maybeError.status === 503 ||
    text.includes("schema cache") ||
    text.includes("recovery mode") ||
    text.includes("no connection")
  );
}

/**
 * Runs a Supabase query and retries it while it returns a transient error.
 * Delay grows linearly (700ms, 1400ms, ...). Returns the last response, so
 * callers still see the error if every attempt fails.
 */
export async function withTransientRetry<T extends { error?: unknown }>(
  operation: () => PromiseLike<T>,
  attempts = 4,
): Promise<T> {
  let response = await operation();
  for (
    let attempt = 1;
    attempt < attempts && isTransientBackendError(response.error);
    attempt += 1
  ) {
    await wait(700 * attempt);
    response = await operation();
  }
  return response;
}
