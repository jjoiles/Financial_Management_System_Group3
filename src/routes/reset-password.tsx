import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { describeAuthError, isRecoveryUrl, readAuthLinkError, validateNewPassword } from "@/lib/auth-recovery";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
  head: () => ({
    meta: [
      { title: "Reset Password — FinReq" },
      { name: "description", content: "Set a new password for your FinReq university finance account." },
      { property: "og:title", content: "Reset Password — FinReq" },
      { property: "og:description", content: "Securely set a new password for your FinReq account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type LinkState = "checking" | "ready" | "invalid";

function ResetPasswordPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [linkState, setLinkState] = useState<LinkState>("checking");
  const [linkError, setLinkError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { hash, search } = window.location;
    const carriedError = readAuthLinkError(hash, search);
    if (carriedError) {
      setLinkError(carriedError);
      setLinkState("invalid");
      return;
    }
    const fromLink = isRecoveryUrl(hash, search);
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (fromLink && session)) setLinkState("ready");
    });
    supabase.auth.getSession().then(({ data: s }) => {
      if (s.session && fromLink) setLinkState("ready");
    });
    const timer = window.setTimeout(() => {
      setLinkState((current) => (current === "checking" ? "invalid" : current));
    }, 4000);
    return () => {
      data.subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const problem = validateNewPassword(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await auth.updatePassword(password);
      setDone(true);
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(describeAuthError(err, "Could not update your password."));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring";

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl shadow-primary/5">
        <KeyRound className="h-8 w-8 text-primary" />
        <h1 className="mt-3 text-2xl font-bold text-card-foreground">Set a new password</h1>

        {done ? (
          <div className="mt-4 space-y-4">
            <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">Your password has been updated.</p>
            <button onClick={() => navigate({ to: "/login" })} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Continue to sign in
            </button>
          </div>
        ) : linkState === "checking" ? (
          <p className="mt-4 text-sm text-muted-foreground">Checking your reset link…</p>
        ) : linkState === "invalid" ? (
          <div className="mt-4 space-y-4">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {linkError || "This reset link is invalid or has expired."} Request a new link from the sign-in page.
            </p>
            <Link to="/login" className="block w-full rounded-md bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            {auth.needsMfa && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Your account uses an authenticator app. If saving fails, sign in and complete the authenticator step first.
              </p>
            )}
            {[
              { label: "New password", value: password, set: setPassword },
              { label: "Confirm new password", value: confirm, set: setConfirm },
            ].map((f) => (
              <label key={f.label} className="block">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{f.label}</span>
                <span className="relative block">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input required type="password" autoComplete="new-password" value={f.value} onChange={(e) => f.set(e.target.value)} className={inputClass} />
                </span>
              </label>
            ))}
            <button type="submit" disabled={busy} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              Save new password
            </button>
          </form>
        )}
        {error && <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
