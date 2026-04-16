import { Link, useLocation } from "@tanstack/react-router";
import { useAppContext } from "@/lib/app-context";
import {
  LayoutDashboard,
  FileText,
  ClipboardList,
  BarChart3,
  Search,
  ChevronRight,
  Building2,
} from "lucide-react";

const navItems = [
  { to: "/", label: "Overview", icon: LayoutDashboard, roles: ["admin", "requester", "leadership"] as const },
  { to: "/submit", label: "New Request", icon: FileText, roles: ["requester", "admin"] as const },
  { to: "/requests", label: "All Requests", icon: ClipboardList, roles: ["admin"] as const },
  { to: "/tracking", label: "My Requests", icon: Search, roles: ["requester"] as const },
  { to: "/analytics", label: "Analytics", icon: BarChart3, roles: ["leadership", "admin"] as const },
];

export default function AppSidebar() {
  const location = useLocation();
  const { role } = useAppContext();

  const visibleItems = navItems.filter((item) =>
    (item.roles as readonly string[]).includes(role)
  );

  return (
    <aside className="fixed left-0 top-0 bottom-0 z-30 flex w-60 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2.5 px-5 border-b border-sidebar-border">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary">
          <Building2 className="h-4 w-4 text-sidebar-primary-foreground" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold font-[family-name:var(--font-display)] text-sidebar-primary-foreground">FinReq</span>
          <span className="text-[10px] text-sidebar-foreground/50">University Finance</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {visibleItems.map((item) => {
          const isActive = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {isActive && <ChevronRight className="h-3.5 w-3.5 opacity-50" />}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 mb-2">Active Role</div>
        <div className="text-xs font-medium text-sidebar-primary capitalize">{role}</div>
      </div>
    </aside>
  );
}
