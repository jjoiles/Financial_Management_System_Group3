import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { Route as SubmitRoute } from "../src/routes/submit";
import { scenarios, selectScenario } from "./submission-fixture";
import "../src/styles.css";

export function Layout() {
  return (
    <>
      <header
        style={{
          padding: "16px 32px",
          background: "#e8f0ff",
          color: "#12274a",
          borderBottom: "2px solid #3268b3",
        }}
      >
        <strong>LOCAL VERIFICATION HARNESS</strong>
        <p>
          Actual submission page and service. Fixture authentication, in-memory persistence, and
          simulated workflow. No live backend writes.
        </p>
        <label>
          Test scenario:{" "}
          <select
            aria-label="Test scenario"
            onChange={(event) => selectScenario(event.target.value)}
          >
            {scenarios.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </header>
      <main style={{ padding: "24px 32px" }}>
        <Outlet />
      </main>
    </>
  );
}
const root = createRootRoute({ component: Layout });
const page = createRoute({
  getParentRoute: () => root,
  path: "/verification/index.html",
  component: SubmitRoute.options.component,
});
const router = createRouter({ routeTree: root.addChildren([page]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
