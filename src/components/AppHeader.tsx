import { useState } from "react";
import { useAppContext } from "@/lib/app-context";
import { mockNotifications, type UserRole } from "@/lib/mock-data";
import { Bell, ChevronDown, User } from "lucide-react";

export default function AppHeader() {
  const { role, setRole } = useAppContext();
  const [showNotifs, setShowNotifs] = useState(false);
  const [showRole, setShowRole] = useState(false);
  const unread = mockNotifications.filter((n) => !n.read).length;

  const roles: { value: UserRole; label: string }[] = [
    { value: "requester", label: "Faculty / Staff" },
    { value: "admin", label: "Admin / Reviewer" },
    { value: "leadership", label: "Leadership" },
  ];

  return (
    <header className="fixed top-0 left-60 right-0 z-20 flex h-16 items-center justify-between border-b border-border bg-card px-6">
      <div>
        <h2 className="text-lg font-semibold font-[family-name:var(--font-display)] text-foreground">
          Financial Request Management
        </h2>
      </div>

      <div className="flex items-center gap-3">
        {/* Role Switcher */}
        <div className="relative">
          <button
            onClick={() => { setShowRole(!showRole); setShowNotifs(false); }}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="capitalize">{role}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          {showRole && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
              {roles.map((r) => (
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

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => { setShowNotifs(!showNotifs); setShowRole(false); }}
            className="relative flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-accent"
          >
            <Bell className="h-4 w-4 text-muted-foreground" />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
                {unread}
              </span>
            )}
          </button>
          {showNotifs && (
            <div className="absolute right-0 top-full mt-1 w-80 rounded-lg border border-border bg-card shadow-lg">
              <div className="border-b border-border px-4 py-3">
                <span className="text-sm font-semibold text-foreground">Notifications</span>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {mockNotifications.map((n) => (
                  <div
                    key={n.id}
                    className={`flex gap-3 border-b border-border/50 px-4 py-3 ${!n.read ? "bg-primary/5" : ""}`}
                  >
                    <div className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                      n.type === "success" ? "bg-success" : n.type === "warning" ? "bg-warning" : "bg-info"
                    }`} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">{n.title}</p>
                      <p className="text-xs text-muted-foreground">{n.message}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground/60">{n.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
