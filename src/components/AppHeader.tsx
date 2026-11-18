import { useState } from "react";
import { useAppContext } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { type UserRole } from "@/lib/mock-data";
import { ChevronDown, LogOut, Menu, ShieldCheck, User } from "lucide-react";
import RequesterNotifications from "@/components/RequesterNotifications";

export default function AppHeader() {
  const { role, setRole } = useAppContext();
  const { profile, user, signOut, roles: availableRoles } = useAuth();
  const [showRole, setShowRole] = useState(false);

  const roleOptions: { value: UserRole; label: string }[] = [
    { value: "requester", label: "Faculty / Staff" },
    { value: "admin", label: "Admin / Reviewer" },
    { value: "leadership", label: "Leadership" },
  ];

  return (
    <header className="fixed left-0 right-0 top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-card/90 px-4 shadow-sm shadow-primary/5 backdrop-blur lg:left-64 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground lg:hidden" aria-label="Open navigation">
          <Menu className="h-4 w-4" />
        </button>
        <div className="min-w-0">
        <h2 className="text-lg font-semibold font-[family-name:var(--font-display)] text-foreground">
          Financial Request Management
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">{profile?.department ?? "University Administration"} · secure AAL2 workspace</p>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="hidden items-center gap-1.5 rounded-full border border-border bg-success/10 px-3 py-1 text-xs font-medium text-success md:flex">
          <ShieldCheck className="h-3.5 w-3.5" />
          2FA verified
        </div>
        {/* Role Switcher */}
        <div className="relative">
          <button
            onClick={() => { setShowRole(!showRole); }}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="capitalize">{role}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          {showRole && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
              {roleOptions.filter((r) => availableRoles.includes(r.value)).map((r) => (
                <button
                  key={r.value}
                  onClick={() => { setRole(r.value); setShowRole(false); }}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs transition-colors ${
                    role === r.value ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <RequesterNotifications />

        <div className="hidden min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 sm:flex">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
            {(profile?.display_name || user?.email || "U").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">{profile?.display_name || user?.email}</p>
            <p className="truncate text-[10px] text-muted-foreground">{user?.email}</p>
          </div>
        </div>

        <button onClick={signOut} className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground" aria-label="Sign out">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
