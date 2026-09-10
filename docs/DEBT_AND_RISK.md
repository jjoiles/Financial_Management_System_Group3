# Risk & Technical Debt Inventory

**Project:** FinReq — University Financial Request Management System  
**Team:** Group 3  
**Module:** 1 – Senior Project II Reset: From Prototypes to Products  
**Date:** September 10, 2026  
**Tool Used for Audit:** Google Antigravity (codebase scan + verification)

---

## Part 1: Technical Debt Audit

### Item 1 — Monolithic Route Files with No Separation of Concerns

- **Category:** Architectural Debt
- **Description:** The Lovable.dev generator produced route files that combine UI rendering, business logic, data access, validation, retry logic, and inline sub-components into single files. The worst offender is `src/routes/submit.tsx` at 485 lines — it contains a Zod validation schema, a routing decision map, a random ID generator, a database insertion function with exponential-backoff retry, localStorage prototype fallback logic, Supabase storage upload loops, workflow event creation, and four inline UI components (`Input`, `ErrorText`, `Meta`, `FlowStep`), all in one file. There is no service layer, no custom hooks for data mutations, and no separation between what the user sees and what talks to the database. Every route directly calls `supabase.from(...)` inside UI event handlers.
- **Remediation Plan:** Extract the Zod schema and validation logic into `src/schemas/request-schema.ts`. Extract all Supabase database operations (insert, upload, workflow event creation) into a service module at `src/services/requests.ts`. Extract the retry and error-handling utilities into `src/lib/retry.ts`. Convert the `handleSubmit` flow into a custom hook (`useSubmitRequest`). The route file should only contain JSX rendering and call the hook. Apply the same pattern to `login.tsx` (224 lines) by extracting MFA logic into `src/services/auth.ts`.

---

### Item 2 — Zero Automated Test Coverage

- **Category:** Test Debt
- **Description:** The entire codebase has zero test files — no `.test.ts`, `.test.tsx`, `.spec.ts`, or `__tests__/` directories exist anywhere in `src/`. There is no test runner configured: `package.json` contains no test dependencies (no Vitest, no Jest, no Testing Library), and no `test` script in the scripts block. This means the Zod validation schema (which enforces Howard email domains, conditional grant number requirements, PI name auto-prepend, date constraints, and amount limits) has never been verified by automated tests. The auth flow, MFA enrollment, role-based access, file upload handling, and prototype fallback behavior are all completely untested. There is no "trust but verify" protocol for any AI-generated component.
- **Remediation Plan:** Install Vitest and `@testing-library/react` as dev dependencies. Add a `"test": "vitest"` script to `package.json`. Prioritize unit tests for: (1) the Zod `requestSchema` — test valid inputs, invalid emails, past dates, negative amounts, conditional research/university fields, and the "Dr." auto-prepend transform; (2) the `toEnriched` data mapper in `requests-data.ts`; (3) the `isTransientBackendError` classifier. Add integration tests for the auth flow and form submission. Establish a CI gate requiring tests to pass before merging PRs.

---

### Item 3 — Hardcoded Mock Data Powering Production Views

- **Category:** Architectural Debt
- **Description:** `src/lib/mock-data.ts` contains 8 hardcoded fake financial requests (dated April 2025), 4 static notification objects with frozen relative timestamps ("2 min ago"), and entirely fabricated chart data for monthly submissions, funding distribution percentages, and department turnaround times. The analytics page (`src/routes/analytics.tsx`) imports `monthlyData`, `fundingDistribution`, and `turnaroundData` directly from this file — meaning all three charts display completely static fake numbers regardless of what's in the database. The notification dropdown in `src/components/AppHeader.tsx` reads from `mockNotifications` — there is no notifications table in Supabase. The dashboard shows a hardcoded "Avg. Turnaround: 4.8 days" string. These mock data paths were created by the AI generator for visual demo purposes and were never replaced with real data queries.
- **Remediation Plan:** Create a `notifications` table in Supabase and replace the `mockNotifications` import in `AppHeader.tsx` with a real query. Replace the three chart data imports in `analytics.tsx` with aggregation queries against the `financial_requests` table (e.g., `GROUP BY date_trunc('month', created_at)` for monthly trends, `GROUP BY funding_source` for distribution). Calculate real turnaround averages from `created_at` vs `updated_at` deltas. Once all consumers are migrated, delete `src/lib/mock-data.ts` entirely.

---

### Item 4 — Prototype localStorage Fallback Masking Real Failures

- **Category:** Architectural Debt
- **Description:** When Supabase database inserts fail for any reason, the submit form silently falls back to saving the request in the browser's `localStorage` under the key `prototype-financial-requests` (submit.tsx lines 222–227). The same pattern applies to attachments (`prototype-request-attachments`). The data-fetching hook in `requests-data.ts` then unconditionally merges these localStorage records with real database rows on every load (line 103–104), making prototype data appear alongside real data. Worse, in `tracking.tsx` line 26, any request marked `prototype: true` is shown to **any user** on that browser regardless of ownership. This pattern was introduced because the second Supabase migration (`20260428002943`) revokes `EXECUTE` permissions on the RLS helper functions `has_role` and `is_admin_or_reviewer`, causing all authenticated queries to fail. The AI generator added the localStorage fallback to work around this broken migration instead of fixing it.
- **Remediation Plan:** Fix the root cause first: create a new migration that re-grants `EXECUTE` on `has_role` and `is_admin_or_reviewer` to the `authenticated` role so RLS policies work correctly. Once the database is functional, remove all `savePrototypeRequest`, `savePrototypeAttachments`, and `readPrototypeRequests` functions. Remove the `prototype` flag from the data types. Remove the `localStorage` merge logic from `useFinancialRequests`. If graceful offline behavior is desired later, implement it properly with a service worker and sync queue rather than silent data loss.

---

### Item 5 — `.env` File Not Gitignored and Hardcoded Demo Credentials

- **Category:** Documentation Debt / Security
- **Description:** The `.gitignore` file does not include `.env` — only `*.local` and `.dev.vars` are ignored. This means the `.env` file containing Supabase project URLs and publishable keys is at risk of being committed to version control and pushed to the public GitHub repository. There is no `.env.example` template file for onboarding new team members. Additionally, the login page (`src/routes/login.tsx` lines 20–23) ships with pre-filled demo credentials: email `faculty@howard.edu`, password `SecurePass123!`, display name "Dr. Sarah Chen", and department "Chemistry" — all hardcoded as React state defaults. These credentials are visible to anyone who views the source code or opens the login page.
- **Remediation Plan:** Immediately add `.env` to `.gitignore`. Run `git rm --cached .env` if it has already been committed. Create a `.env.example` file with placeholder values and instructions. Remove the pre-filled credentials from `login.tsx` — replace them with empty strings and use placeholder attributes on the inputs instead. Rotate any Supabase keys that may have been exposed in the git history.

---

### Item 6 — 46 Unused UI Components and 12+ Dead Dependencies

- **Category:** Architectural Debt
- **Description:** Lovable.dev bulk-installed 46 shadcn/ui component files in `src/components/ui/` (accordion, alert-dialog, calendar, carousel, command, drawer, form, etc.) totaling ~4,000 lines and ~140KB. None of these are imported by any active route or business component — the application uses custom inline inputs, native HTML selects, and hand-written modal dialogs instead. Correspondingly, 12+ npm packages installed as dependencies are completely unused in production code: `@tanstack/react-query`, `framer-motion` (500KB+), `date-fns`, `react-hook-form`, `@hookform/resolvers`, `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`, `sonner`, `vaul`, and 25+ `@radix-ui/*` packages. These inflate bundle size, increase install time, and create a false impression of the project's complexity. TypeScript's `noUnusedLocals` and `noUnusedParameters` are both set to `false`, and ESLint's `@typescript-eslint/no-unused-vars` is turned off — so none of this dead code generates warnings.
- **Remediation Plan:** Audit each file in `src/components/ui/` — decide whether to migrate existing inline components to use the shadcn components (preferred for consistency) or delete the unused ones. Uninstall all unused npm packages. Enable `noUnusedLocals: true` and `noUnusedParameters: true` in `tsconfig.json`. Turn on the `@typescript-eslint/no-unused-vars` ESLint rule. Run the build to identify and clean up remaining dead imports.

---

### Item 7 — Supabase Type Safety Bypassed with `as any` Casts

- **Category:** Test Debt
- **Description:** The project has a 383-line auto-generated Supabase type definition file (`src/integrations/supabase/types.ts`) that provides full TypeScript types for every table, column, and relationship. However, the AI-generated code bypasses this entirely by casting the Supabase client to `any` in every location where it's used: `const client = supabase as any` (submit.tsx line 194), `client: any` in the function signature (submit.tsx line 101), and `(supabase as any).from(...)` (requests-data.ts line 88). This means TypeScript cannot verify that column names, table names, or query shapes are correct — a misspelled column name or wrong data type would only surface as a runtime error in production, not a compile-time error. This defeats the purpose of having generated types and prevents any "trust but verify" validation of the AI-generated database queries.
- **Remediation Plan:** Remove all `as any` casts on the Supabase client. Use the properly typed client directly: `supabase.from("financial_requests").insert(...)` will now be type-checked against the `Database` type. Fix any resulting type errors — these will reveal actual mismatches between the code and the database schema. Update the `insertFinancialRequest` function signature to accept the typed Supabase client instead of `any`.

---

## Part 2: AI & System Risk Assessment

### Risk 1 — AI Hallucinated a Broken Migration That Silently Degrades the System

- **Category:** Reliability / Hallucination
- **Description:** The Lovable.dev AI generated two sequential Supabase migrations. The first migration (`20260428002922`) creates RLS policies that depend on `has_role()` and `is_admin_or_reviewer()` security-definer functions. The second migration (`20260428002943`), generated moments later, revokes `EXECUTE` permissions on those exact functions from the `authenticated` role. This creates a contradiction: RLS policies call functions that users don't have permission to execute, causing every authenticated database query to fail with `permission denied`. Rather than surfacing this error to the developer or fixing the migration, the AI then generated elaborate workarounds: a `transientBackendCodes` error classifier (submit.tsx line 58), an `isTransientBackendError` function (submit.tsx lines 68–78), an exponential-backoff retry loop (submit.tsx lines 94–122), and an entire localStorage prototype fallback system (submit.tsx lines 124–157) — treating a self-inflicted schema bug as a "transient backend error." The AI essentially hallucinated a problem and then hallucinated an increasingly complex set of band-aids to hide it.
- **Remediation Plan:** Create a corrective migration that grants `EXECUTE` on both helper functions to the `authenticated` role. Verify RLS policies work by testing queries as an authenticated user. Once confirmed, simplify or remove the retry logic and eliminate the localStorage fallback entirely. Establish a review protocol where all AI-generated migrations are tested against a staging database before deployment.

---

### Risk 2 — Unrestricted File Uploads and XSS via `dangerouslySetInnerHTML`

- **Category:** Security & Ethics
- **Description:** The file upload input in `submit.tsx` (line 406) has no `accept` attribute, no MIME type validation, and no file size limit. Users can upload `.exe`, `.bat`, `.html`, `.svg`, or any file type to the Supabase storage bucket. SVG files can contain embedded JavaScript that executes when viewed by an admin or reviewer, creating a stored XSS vector. Separately, in `login.tsx` (line 162), the TOTP setup QR code is rendered using `dangerouslySetInnerHTML={{ __html: setup.qrCode }}` — injecting raw HTML/SVG from the Supabase MFA API directly into the DOM without sanitization. If the MFA response were compromised or modified by a man-in-the-middle attack, arbitrary scripts could execute in the user's browser. Additionally, there is no server-side validation — the Zod schema only runs on the client, so any validation can be bypassed by directly calling the Supabase API.
- **Remediation Plan:** Add an `accept` attribute to the file input restricting uploads to safe document types (`.pdf, .doc, .docx, .xls, .xlsx, .png, .jpg`). Add client-side MIME type checking and a 10MB file size cap before uploading. Add a Supabase storage policy or Edge Function that rejects disallowed file types server-side. Replace the `dangerouslySetInnerHTML` QR code rendering with a dedicated QR library (e.g., `qrcode.react`) that generates safe DOM elements. Add server-side validation via a Supabase Edge Function or database trigger to enforce the same Zod rules on the backend.

---

### Risk 3 — Lovable.dev Vendor Lock-in Creates Single Point of Failure

- **Category:** Dependency Risk
- **Description:** The project depends on two proprietary Lovable.dev packages that cannot be replaced without significant refactoring: (1) `@lovable.dev/cloud-auth-js` powers the Google OAuth sign-in flow — the `signInWithGoogle` function in `auth-context.tsx` (line 177) routes through `lovable.auth.signInWithOAuth("google", ...)` instead of using Supabase's native `supabase.auth.signInWithOAuth()`. If Lovable changes their auth API, deprecates the package, or alters pricing, Google sign-in breaks entirely. (2) `@lovable.dev/vite-tanstack-config` wraps the entire Vite build configuration — `vite.config.ts` consists of a single line: `export default defineConfig()` from Lovable's package. This means the team cannot customize Vite plugins, adjust build settings, add environment-specific configurations, or debug build issues without reverse-engineering what Lovable's opaque wrapper does. The project cannot be built without these proprietary packages, creating a single point of failure tied to an external company's platform.
- **Remediation Plan:** Replace `lovable.auth.signInWithOAuth` with Supabase's native `supabase.auth.signInWithOAuth({ provider: "google" })`, which is already documented and supported. Uninstall `@lovable.dev/cloud-auth-js` and delete `src/integrations/lovable/index.ts`. Replace `@lovable.dev/vite-tanstack-config` with a standard `vite.config.ts` that explicitly configures `@vitejs/plugin-react`, `vite-tsconfig-paths`, `@tanstack/router-plugin/vite`, `@tailwindcss/vite`, and `@cloudflare/vite-plugin`. This eliminates both vendor lock-in dependencies and gives the team full control over the build pipeline.

---

### Risk 4 — Client-Side Role Switching Defaults to Admin

- **Category:** Security & Ethics
- **Description:** In `src/lib/app-context.tsx` (line 17), the application role state is initialized to `"admin"` by default: `const [role, setRole] = useState<UserRole>("admin")`. Until the auth context loads and overrides this, every user temporarily has admin-level UI access. Furthermore, the `AppHeader.tsx` component (line 54) renders a client-side role switcher dropdown that allows any authenticated user to change their role to "admin" or "leadership" in the browser, granting access to UI elements that should be restricted. While RLS policies on the database side would block unauthorized data access (if they were working — see Risk 1), the UI still exposes admin workflows, review actions, and sensitive dashboard data to unauthorized users.
- **Remediation Plan:** Change the default role initialization from `"admin"` to `"requester"`. Remove the client-side role switcher from `AppHeader.tsx` in production — it was generated as a demo/prototyping convenience. Derive the user's role solely from the database `user_roles` table via the auth context. Implement route-level guards using TanStack Router's `beforeLoad` to redirect unauthorized users before the route renders.

---

## Part 3: Backlog Integration

Based on the audit above, the top 3 items to convert into GitHub Issues on the project board are:

1. **Item 5 — `.env` File Not Gitignored and Hardcoded Demo Credentials** → Create an issue tagged `technical-debt` + `security`. This is the most immediately actionable and highest-risk item.

2. **Item 2 — Zero Automated Test Coverage** → Create an issue tagged `technical-debt`. This blocks the ability to safely refactor any other debt item.

3. **Item 1 — Monolithic Route Files with No Separation of Concerns** → Create an issue tagged `refactor`. This is the foundational architectural change that enables all future feature work.
