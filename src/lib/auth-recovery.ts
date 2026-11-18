/**
 * Browser-safe helpers for sign-up, email-confirmation recovery and password reset.
 * Messages are deliberately neutral so the UI never reveals whether an email is registered.
 */

export const PUBLIC_AUTH_ROUTES = ["/login", "/reset-password"] as const;

export function isPublicAuthRoute(pathname: string): boolean {
  return (PUBLIC_AUTH_ROUTES as readonly string[]).includes(pathname);
}

export const MIN_PASSWORD_LENGTH = 8;

export const NEUTRAL_RESEND_MESSAGE =
  "If an account with that email is waiting for confirmation, a new confirmation link is on its way. Check your inbox and spam folder.";

export const NEUTRAL_RESET_MESSAGE =
  "If an account exists for that email, a password reset link is on its way. Check your inbox and spam folder.";

export const SIGNUP_CONFIRM_MESSAGE =
  "Check your email to confirm your account, then sign in. Didn't get it? Use \"Resend confirmation email\" below.";

export const UNCONFIRMED_LOGIN_MESSAGE =
  "Your email address hasn't been confirmed yet. Open the confirmation link we emailed you, or resend it below.";

type AuthLikeError = { message?: unknown; code?: unknown } | null | undefined;

export function isEmailNotConfirmedError(error: unknown): boolean {
  const e = error as AuthLikeError;
  if (!e || typeof e !== "object") return false;
  if (e.code === "email_not_confirmed") return true;
  return typeof e.message === "string" && /email not confirmed/i.test(e.message);
}

/** Map raw auth errors to user-facing text without revealing account existence. */
export function describeAuthError(error: unknown, fallback = "Authentication failed. Please try again."): string {
  if (isEmailNotConfirmedError(error)) return UNCONFIRMED_LOGIN_MESSAGE;
  const e = error as AuthLikeError;
  const code = e && typeof e === "object" ? e.code : undefined;
  const message = e && typeof e === "object" && typeof e.message === "string" ? e.message : "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "Email or password is incorrect.";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || /rate limit/i.test(message)) {
    return "Too many attempts. Please wait a few minutes and try again.";
  }
  if (code === "weak_password" || /password should/i.test(message)) {
    return message || "Please choose a stronger password.";
  }
  if (code === "same_password") return "Choose a password different from your current one.";
  if (code === "insufficient_aal" || /aal2/i.test(message)) {
    return "Verify your authenticator code before changing your password.";
  }
  return message || fallback;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return "Passwords do not match.";
  return null;
}

export function buildAuthRedirect(origin: string, path = "/"): string {
  const safePath = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  return `${origin.replace(/\/+$/, "")}${safePath}`;
}

/** True when the URL carries a recovery link marker (implicit hash or PKCE code). */
export function isRecoveryUrl(hash: string, search: string): boolean {
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  if (h.get("type") === "recovery") return true;
  const s = new URLSearchParams(search.replace(/^\?/, ""));
  return s.get("type") === "recovery" || s.has("code");
}

/** Extract an error carried back in a failed/expired auth link. */
export function readAuthLinkError(hash: string, search: string): string | null {
  for (const raw of [hash.replace(/^#/, ""), search.replace(/^\?/, "")]) {
    const p = new URLSearchParams(raw);
    const desc = p.get("error_description") || p.get("error");
    if (desc) return desc.replace(/\+/g, " ");
  }
  return null;
}
