import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Building2, KeyRound, Lock, Mail, QrCode, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Secure Sign In — FinReq" },
      { name: "description", content: "Sign in with two-factor authentication for university financial request management." },
    ],
  }),
});

function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("faculty@university.edu");
  const [password, setPassword] = useState("SecurePass123!");
  const [displayName, setDisplayName] = useState("Dr. Sarah Chen");
  const [department, setDepartment] = useState("Chemistry");
  const [mfaCode, setMfaCode] = useState("");
  const [setup, setSetup] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const canEnterApp = auth.user && (auth.mfaVerified || !auth.hasTotpFactor);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");

    try {
      if (mode === "signup") {
        await auth.signUp(email, password, displayName, department);
        setMessage("Account created. Check your email to confirm, then sign in and enroll your authenticator app.");
        setMode("signin");
        return;
      }
      await auth.signIn(email, password);
      setMessage("Password accepted. Complete the authenticator step to continue.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    }
  };

  const startTotpSetup = async () => {
    setError("");
    try {
      setSetup(await auth.enrollTotp());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start 2FA setup.");
    }
  };

  const verifyCode = async () => {
    setError("");
    try {
      if (setup) {
        await auth.verifyEnrollment(setup.factorId, mfaCode);
      } else {
        await auth.verifyMfa(mfaCode);
      }
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid verification code.");
    }
  };

  if (canEnterApp) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-xl shadow-primary/5">
          <ShieldCheck className="mx-auto h-10 w-10 text-success" />
          <h1 className="mt-4 text-2xl font-bold text-card-foreground">Secure session active</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your account is authenticated and ready for workflow access.</p>
          <button onClick={() => navigate({ to: "/" })} className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
            Open dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sidebar-primary">
            <Building2 className="h-5 w-5 text-sidebar-primary-foreground" />
          </div>
          <div>
            <p className="text-lg font-bold text-sidebar-primary-foreground">FinReq</p>
            <p className="text-xs text-sidebar-foreground/60">University financial controls</p>
          </div>
        </div>
        <div className="relative z-10 max-w-xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-sidebar-border bg-sidebar-accent px-3 py-1 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-sidebar-primary" />
            Automated routing with verified access
          </div>
          <h1 className="text-5xl font-bold leading-tight text-sidebar-primary-foreground">Financial workflows with second-factor assurance.</h1>
          <p className="mt-5 text-base leading-7 text-sidebar-foreground/70">Requests, attachments, approvals, and leadership insights stay protected behind password, Google sign-in, and authenticator app verification.</p>
        </div>
        <div className="relative z-10 grid grid-cols-3 gap-3">
          {["AAL2 session", "Encrypted files", "Audit trail"].map((item) => (
            <div key={item} className="rounded-xl border border-sidebar-border bg-sidebar-accent/70 p-4 text-xs font-medium text-sidebar-accent-foreground">
              {item}
            </div>
          ))}
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-7 lg:hidden">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary">
                <Building2 className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <p className="font-bold text-foreground">FinReq</p>
                <p className="text-xs text-muted-foreground">University Finance</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6 shadow-xl shadow-primary/5">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-card-foreground">{auth.user ? "Two-factor verification" : mode === "signin" ? "Sign in" : "Create account"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">Secure access for requesters, reviewers, and leadership.</p>
            </div>

            {!auth.user ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                {mode === "signup" && (
                  <>
                    <Field icon={UserRound} label="Display name" value={displayName} onChange={setDisplayName} />
                    <Field icon={Building2} label="Department" value={department} onChange={setDepartment} />
                  </>
                )}
                <Field icon={Mail} label="Email" type="email" value={email} onChange={setEmail} />
                <Field icon={Lock} label="Password" type="password" value={password} onChange={setPassword} />
                <button type="submit" className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
                  {mode === "signin" ? "Continue securely" : "Create secure account"}
                </button>
                <button type="button" onClick={auth.signInWithGoogle} className="w-full rounded-md border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-accent">
                  Continue with Google
                </button>
                <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="w-full text-sm font-medium text-primary hover:underline">
                  {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
                </button>
              </form>
            ) : auth.needsMfa ? (
              <MfaPanel code={mfaCode} setCode={setMfaCode} onVerify={verifyCode} />
            ) : setup ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-background p-4 text-center">
                  <div className="mx-auto mb-3 flex h-44 w-44 items-center justify-center rounded-lg bg-card p-3" dangerouslySetInnerHTML={{ __html: setup.qrCode }} />
                  <p className="text-xs text-muted-foreground">Manual key: <span className="font-mono text-foreground">{setup.secret}</span></p>
                </div>
                <MfaPanel code={mfaCode} setCode={setMfaCode} onVerify={verifyCode} />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-background p-4">
                  <div className="flex items-start gap-3">
                    <QrCode className="mt-1 h-5 w-5 text-primary" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Authenticator app required</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">Enroll Google Authenticator, Microsoft Authenticator, or another TOTP app before entering the system.</p>
                    </div>
                  </div>
                </div>
                <button onClick={startTotpSetup} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
                  Set up authenticator app
                </button>
              </div>
            )}

            {(error || message) && (
              <p className={`mt-4 rounded-md px-3 py-2 text-xs ${error ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}>
                {error || message}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({ icon: Icon, label, value, onChange, type = "text" }: { icon: typeof Mail; label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-foreground">{label}</span>
      <span className="relative block">
        <Icon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input required type={type} value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring" />
      </span>
    </label>
  );
}

function MfaPanel({ code, setCode, onVerify }: { code: string; setCode: (code: string) => void; onVerify: () => void }) {
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-foreground">Six-digit verification code</span>
        <span className="relative block">
          <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-center font-mono text-lg tracking-[0.3em] text-foreground outline-none transition focus:ring-2 focus:ring-ring" placeholder="000000" />
        </span>
      </label>
      <button disabled={code.length !== 6} onClick={onVerify} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
        Verify and continue
      </button>
    </div>
  );
}
