import { Outlet, Link, createRootRoute, HeadContent, Scripts, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import appCss from "../styles.css?url";
import AppSidebar from "@/components/AppSidebar";
import AppHeader from "@/components/AppHeader";
import { AppProvider } from "@/lib/app-context";
import { AuthProvider, useAuth } from "@/lib/auth-context";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground font-[family-name:var(--font-display)]">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "FinReq — University Financial Request Management" },
      { name: "description", content: "Streamline financial request submission, routing, and tracking across university departments." },
      { property: "og:title", content: "FinReq — University Financial Request Management" },
      { name: "twitter:title", content: "FinReq — University Financial Request Management" },
      { property: "og:description", content: "Streamline financial request submission, routing, and tracking across university departments." },
      { name: "twitter:description", content: "Streamline financial request submission, routing, and tracking across university departments." },
      { name: "twitter:card", content: "summary" },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <AuthProvider>
      <AppFrame />
    </AuthProvider>
  );
}

function AppFrame() {
  const auth = useAuth();
  const location = useLocation();
  const isLoginRoute = location.pathname === "/login";

  useEffect(() => {
    if (!isLoginRoute && !auth.loading && (!auth.user || auth.needsMfa)) {
      window.location.href = "/login";
    }
  }, [auth.loading, auth.needsMfa, auth.user, isLoginRoute]);

  if (isLoginRoute) return <Outlet />;

  if (auth.loading) {
    return <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Loading secure workspace…</div>;
  }

  if (!auth.user || auth.needsMfa) {
    return <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Opening secure sign in…</div>;
  }

  return (
    <AppProvider>
      <div className="min-h-screen bg-background lg:flex">
        <AppSidebar />
        <div className="min-w-0 flex-1 lg:ml-64">
          <AppHeader />
          <main className="px-4 pb-8 pt-20 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </AppProvider>
  );
}
