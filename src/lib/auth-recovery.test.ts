import { describe, expect, it } from "vitest";
import {
  NEUTRAL_RESEND_MESSAGE,
  NEUTRAL_RESET_MESSAGE,
  UNCONFIRMED_LOGIN_MESSAGE,
  buildAuthRedirect,
  describeAuthError,
  isEmailNotConfirmedError,
  isPublicAuthRoute,
  isRecoveryUrl,
  isValidEmail,
  normalizeEmail,
  readAuthLinkError,
  validateNewPassword,
} from "./auth-recovery";

describe("login errors", () => {
  it("detects unconfirmed email by code or message", () => {
    expect(isEmailNotConfirmedError({ code: "email_not_confirmed" })).toBe(true);
    expect(isEmailNotConfirmedError({ message: "Email not confirmed" })).toBe(true);
    expect(isEmailNotConfirmedError({ message: "Invalid login credentials" })).toBe(false);
    expect(isEmailNotConfirmedError(null)).toBe(false);
  });
  it("shows the unconfirmed-email guidance", () => {
    expect(describeAuthError({ code: "email_not_confirmed", message: "Email not confirmed" })).toBe(UNCONFIRMED_LOGIN_MESSAGE);
  });
  it("uses one message for wrong password and unknown account", () => {
    expect(describeAuthError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe("Email or password is incorrect.");
  });
  it("explains rate limits", () => {
    expect(describeAuthError({ code: "over_email_send_rate_limit", message: "x" })).toMatch(/Too many attempts/);
  });
  it("explains that MFA must be completed before changing password", () => {
    expect(describeAuthError({ code: "insufficient_aal", message: "AAL2 required" })).toMatch(/authenticator/);
  });
});

describe("account-existence privacy", () => {
  it("resend and reset messages never confirm an account exists", () => {
    for (const m of [NEUTRAL_RESEND_MESSAGE, NEUTRAL_RESET_MESSAGE]) {
      expect(m.startsWith("If an account")).toBe(true);
      expect(m).not.toMatch(/not found|no account|does not exist/i);
    }
  });
});

describe("password reset", () => {
  it("rejects short and mismatched passwords", () => {
    expect(validateNewPassword("short", "short")).toMatch(/at least 8/);
    expect(validateNewPassword("longenough1", "different1")).toBe("Passwords do not match.");
    expect(validateNewPassword("longenough1", "longenough1")).toBeNull();
  });
  it("builds same-origin redirects and refuses protocol-relative paths", () => {
    expect(buildAuthRedirect("https://app.test/", "/reset-password")).toBe("https://app.test/reset-password");
    expect(buildAuthRedirect("https://app.test", "//evil.test")).toBe("https://app.test/");
  });
  it("recognises recovery links and link errors", () => {
    expect(isRecoveryUrl("#access_token=a&type=recovery", "")).toBe(true);
    expect(isRecoveryUrl("", "?code=abc")).toBe(true);
    expect(isRecoveryUrl("", "")).toBe(false);
    expect(readAuthLinkError("#error=access_denied&error_description=Email+link+is+invalid+or+has+expired", "")).toBe("Email link is invalid or has expired");
    expect(readAuthLinkError("", "")).toBeNull();
  });
  it("reset page is reachable signed out; app pages are not", () => {
    expect(isPublicAuthRoute("/reset-password")).toBe(true);
    expect(isPublicAuthRoute("/login")).toBe(true);
    expect(isPublicAuthRoute("/requests")).toBe(false);
  });
});

describe("sign-up input", () => {
  it("validates and normalizes email", () => {
    expect(isValidEmail("a@howard.edu")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(normalizeEmail("  A@Howard.EDU ")).toBe("a@howard.edu");
  });
});
