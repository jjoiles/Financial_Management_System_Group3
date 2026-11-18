import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import type { UserRole } from "@/lib/mock-data";
import { withTransientRetry } from "@/lib/backend-errors";
import { buildAuthRedirect, normalizeEmail } from "@/lib/auth-recovery";

// Only rate limits surface; other resend/reset errors stay silent so responses never reveal account existence.
const isRateLimited = (error: { code?: string; status?: number; message?: string }) =>
  error.status === 429 || /rate limit/i.test(error.message ?? "") || (error.code ?? "").startsWith("over_");
import { mapDatabaseRoleToPortalRole, retrieveSignedInUserRoles } from "@/lib/rbac";

type Profile = {
  display_name: string;
  department: string | null;
  title: string | null;
  phone: string | null;
};

type AuthContextType = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  needsMfa: boolean;
  hasTotpFactor: boolean;
  mfaVerified: boolean;
  roles: UserRole[];
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    displayName: string,
    department: string,
  ) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  verifyMfa: (code: string) => Promise<void>;
  enrollTotp: () => Promise<{ factorId: string; qrCode: string; secret: string }>;
  verifyEnrollment: (factorId: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

const mapRole = (role: string): UserRole | null => mapDatabaseRoleToPortalRole(role);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<UserRole[]>(["requester"]);
  const [loading, setLoading] = useState(true);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [hasTotpFactor, setHasTotpFactor] = useState(false);
  const [mfaVerified, setMfaVerified] = useState(false);

  const refreshMfaState = async () => {
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const factors = await supabase.auth.mfa.listFactors();
    const hasVerifiedTotp = !!factors.data?.totp?.some((factor) => factor.status === "verified");
    setHasTotpFactor(hasVerifiedTotp);
    setMfaVerified(aal.data?.currentLevel === "aal2");
    setNeedsMfa(
      hasVerifiedTotp && aal.data?.currentLevel !== "aal2" && aal.data?.nextLevel === "aal2",
    );
  };

  const loadProfile = async (activeUser: User | null) => {
    if (!activeUser) {
      setProfile(null);
      setRoles(["requester"]);
      return;
    }

    const fallbackProfile = {
      display_name: activeUser.user_metadata?.display_name ?? activeUser.email?.split("@")[0] ?? "",
      department: activeUser.user_metadata?.department ?? null,
      title: null,
      phone: null,
    };

    // Load the profile independently.
    try {
      const { data: profileData, error: profileError } = await withTransientRetry(() =>
        supabase
          .from("profiles")
          .select("display_name, department, title, phone")
          .eq("user_id", activeUser.id)
          .maybeSingle(),
      );

      if (profileError) {
        setProfile(fallbackProfile);
      } else if (!profileData) {
        const { data: createdProfile } = await supabase
          .from("profiles")
          .upsert(
            {
              user_id: activeUser.id,
              display_name: fallbackProfile.display_name,
              department: fallbackProfile.department,
            },
            { onConflict: "user_id" },
          )
          .select("display_name, department, title, phone")
          .maybeSingle();

        setProfile(createdProfile ?? fallbackProfile);
      } else {
        setProfile(profileData);
      }
    } catch {
      setProfile(fallbackProfile);
    }

    // F21.2.1 & F21.2.2: Load and associate database roles on sign-in.
    const roleAssociation = await retrieveSignedInUserRoles(activeUser.id, (uid) =>
      withTransientRetry(() => supabase.from("user_roles").select("role").eq("user_id", uid)),
    );
    setRoles(roleAssociation?.portalRoles ?? (mapRole("requester") ? ["requester"] : []));
  };

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setLoading(false);
      window.setTimeout(() => {
        void loadProfile(nextSession?.user ?? null);
        void refreshMfaState();
      }, 0);
    });

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
      void loadProfile(data.session?.user ?? null);
      void refreshMfaState();
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      session,
      profile,
      loading,
      needsMfa,
      hasTotpFactor,
      mfaVerified,
      roles,
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await refreshMfaState();
      },
      signUp: async (email, password, displayName, department) => {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { display_name: displayName, department },
          },
        });
        if (error) throw error;
        // Profile rows are created on first authenticated load (loadProfile); with
        // email confirmation on there is no session yet, so no write is attempted here.
      },
      resendConfirmation: async (email) => {
        const { error } = await supabase.auth.resend({
          type: "signup",
          email: normalizeEmail(email),
          options: { emailRedirectTo: buildAuthRedirect(window.location.origin, "/") },
        });
        if (error && isRateLimited(error)) throw error;
      },
      requestPasswordReset: async (email) => {
        const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
          redirectTo: buildAuthRedirect(window.location.origin, "/reset-password"),
        });
        if (error && isRateLimited(error)) throw error;
      },
      updatePassword: async (password) => {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
      },
      signInWithGoogle: async () => {
        const result = await lovable.auth.signInWithOAuth("google", {
          redirect_uri: window.location.origin,
        });
        if (result.error) throw result.error;
        if (!result.redirected) await refreshMfaState();
      },
      verifyMfa: async (code) => {
        const factors = await supabase.auth.mfa.listFactors();
        const factor = factors.data?.totp?.find((item) => item.status === "verified");
        if (!factor) throw new Error("No verified authenticator app is enrolled.");
        const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id });
        if (challenge.error) throw challenge.error;
        const verify = await supabase.auth.mfa.verify({
          factorId: factor.id,
          challengeId: challenge.data.id,
          code,
        });
        if (verify.error) throw verify.error;
        await refreshMfaState();
      },
      enrollTotp: async () => {
        const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
        if (error) throw error;
        return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
      },
      verifyEnrollment: async (factorId, code) => {
        const challenge = await supabase.auth.mfa.challenge({ factorId });
        if (challenge.error) throw challenge.error;
        const verify = await supabase.auth.mfa.verify({
          factorId,
          challengeId: challenge.data.id,
          code,
        });
        if (verify.error) throw verify.error;
        await refreshMfaState();
      },
      signOut: async () => {
        await supabase.auth.signOut();
        setNeedsMfa(false);
        setMfaVerified(false);
        setHasTotpFactor(false);
      },
    }),
    [hasTotpFactor, loading, mfaVerified, needsMfa, profile, roles, session, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
