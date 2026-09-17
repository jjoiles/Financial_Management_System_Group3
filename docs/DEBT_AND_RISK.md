# Risk & Technical Debt Inventory

**Project:** FinReq — University Financial Request Management System  
**Team:** Group 3  
**Module:** 1 – Senior Project II Reset: From Prototypes to Products  
**Date:** September 17, 2026  
**Tool Used for Audit:** Google Antigravity (codebase scan + verification)

---

## Part 1: The Technical Debt Audit

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
- **Description:** `src/lib/mock-data.ts` contains 8 hardcoded fake financial requests (dated April 2025), 4 static notification objects with frozen relative timestamps ("2 min ago"), and entirely fabricated chart data for monthly submissions, funding distribution percentages, and department turnaround times. The analytics page (`src/routes/analytics.tsx` line 15) imports `monthlyData`, `fundingDistribution`, and `turnaroundData` directly from this file — meaning all three charts display completely static fake numbers regardless of what's in the database. The notification dropdown in `src/components/AppHeader.tsx` (line 12) reads from `mockNotifications` — there is no notifications table in Supabase. The analytics page shows a hardcoded "Avg. Turnaround: 4.8 days" string (line 37). These mock data paths were created by the AI generator for visual demo purposes and were never replaced with real data queries.
- **Remediation Plan:** Create a `notifications` table in Supabase and replace the `mockNotifications` import in `AppHeader.tsx` with a real query. Replace the three chart data imports in `analytics.tsx` with aggregation queries against the `financial_requests` table (e.g., `GROUP BY date_trunc('month', created_at)` for monthly trends, `GROUP BY funding_source` for distribution). Calculate real turnaround averages from `created_at` vs `updated_at` deltas. Once all consumers are migrated, delete `src/lib/mock-data.ts` entirely.

---

### Item 4 — Prototype localStorage Fallback Masking Real Failures

- **Category:** Architectural Debt
- **Description:** When Supabase database inserts fail for any reason, the submit form silently falls back to saving the request in the browser's `localStorage` under the key `prototype-financial-requests` (submit.tsx lines 222–227). The same pattern applies to attachments (`prototype-request-attachments`, line 156). The data-fetching hook in `requests-data.ts` then unconditionally merges these localStorage records with real database rows on every load (lines 103–104), making prototype data appear alongside real data. Worse, in `tracking.tsx` line 26, any request marked `prototype: true` is shown to any user on that browser regardless of ownership. This pattern was introduced because the second Supabase migration revokes `EXECUTE` permissions on the RLS helper functions `has_role` and `is_admin_or_reviewer`, causing all authenticated queries to fail. The AI generator added the localStorage fallback to work around this broken migration instead of fixing it.
- **Remediation Plan:** Fix the root cause first: create a new migration that re-grants `EXECUTE` on `has_role` and `is_admin_or_reviewer` to the `authenticated` role so RLS policies work correctly. Once the database is functional, remove all `savePrototypeRequest`, `savePrototypeAttachments`, and `readPrototypeRequests` functions. Remove the `prototype` flag from the data types. Remove the `localStorage` merge logic from `useFinancialRequests`. If graceful offline behavior is desired later, implement it properly with a service worker and sync queue rather than silent data loss.

---

### Item 5 — `.env` File Not Gitignored and Hardcoded Demo Credentials

- **Category:** Documentation Debt
- **Description:** The `.gitignore` file does not include `.env` — only `*.local` and `.dev.vars` are ignored. This means the `.env` file containing Supabase project URLs and publishable keys is at risk of being committed to version control and pushed to the public GitHub repository. There is no `.env.example` template file for onboarding new team members. Additionally, the login page (`src/routes/login.tsx` lines 20–23) ships with pre-filled demo credentials: email `faculty@howard.edu`, password `SecurePass123!`, display name "Dr. Sarah Chen", and department "Chemistry" — all hardcoded as React state defaults. These credentials are visible to anyone who views the source code or opens the login page.
- **Remediation Plan:** Immediately add `.env` to `.gitignore`. Run `git rm --cached .env` if it has already been committed. Create a `.env.example` file with placeholder values and instructions. Remove the pre-filled credentials from `login.tsx` — replace them with empty strings and use placeholder attributes on the inputs instead. Rotate any Supabase keys that may have been exposed in the git history.

---

### Item 6 — 46 Unused UI Components and 12+ Dead Dependencies

- **Category:** Architectural Debt
- **Description:** Lovable.dev bulk-installed 46 shadcn/ui component files in `src/components/ui/` (accordion, alert-dialog, calendar, carousel, command, drawer, form, etc.) totaling ~4,000 lines and ~140KB. None of these are imported by any active route or business component — the application uses custom inline inputs, native HTML selects, and hand-written modal dialogs instead. Correspondingly, 12+ npm packages installed as dependencies are completely unused in production code: `@tanstack/react-query`, `framer-motion` (500KB+), `date-fns`, `react-hook-form`, `@hookform/resolvers`, `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`, `sonner`, `vaul`, and 25+ `@radix-ui/*` packages. These inflate bundle size, increase install time, and create a false impression of the project's complexity. TypeScript's `noUnusedLocals` and `noUnusedParameters` are both set to `false` in `tsconfig.json` (lines 19–20), and ESLint's `@typescript-eslint/no-unused-vars` is turned off in `eslint.config.js` (line 24) — so none of this dead code generates warnings.
- **Remediation Plan:** Audit each file in `src/components/ui/` — decide whether to migrate existing inline components to use the shadcn components (preferred for consistency) or delete the unused ones. Uninstall all unused npm packages. Enable `noUnusedLocals: true` and `noUnusedParameters: true` in `tsconfig.json`. Turn on the `@typescript-eslint/no-unused-vars` ESLint rule. Run the build to identify and clean up remaining dead imports.

---

### Item 7 — Supabase Type Safety Bypassed with `as any` Casts

- **Category:** Test Debt
- **Description:** The project has a 383-line auto-generated Supabase type definition file (`src/integrations/supabase/types.ts`) that provides full TypeScript types for every table, column, and relationship. However, the AI-generated code bypasses this entirely by casting the Supabase client to `any` in every location where it's used: `const client = supabase as any` (submit.tsx line 194), `client: any` in the function signature (submit.tsx line 101), and `(supabase as any).from(...)` (requests-data.ts line 88). This means TypeScript cannot verify that column names, table names, or query shapes are correct — a misspelled column name or wrong data type would only surface as a runtime error in production, not a compile-time error. This defeats the purpose of having generated types and prevents any "trust but verify" validation of the AI-generated database queries.
- **Remediation Plan:** Remove all `as any` casts on the Supabase client. Use the properly typed client directly: `supabase.from("financial_requests").insert(...)` will now be type-checked against the `Database` type. Fix any resulting type errors — these will reveal actual mismatches between the code and the database schema. Update the `insertFinancialRequest` function signature to accept the typed Supabase client instead of `any`.

---

### Item 8 — Bare Catch Blocks Swallowing Errors Silently

- **Category:** Architectural Debt
- **Description:** Multiple `catch` blocks throughout the codebase swallow errors without logging, reporting, or surfacing them to the user. In `src/routes/submit.tsx` line 249, a bare `catch {}` swallows storage upload failures and only sets a local warning string. In `submit.tsx` line 265, another bare `catch {}` swallows workflow event creation failures. In `src/lib/requests-data.ts` line 74, a bare `catch {}` silently ignores JSON parse errors from corrupt localStorage data and returns an empty array. In `src/integrations/lovable/index.ts` line 32, an error is caught and wrapped but the original stack trace is lost. In `src/routes/login.tsx` lines 45, 54, and 68, errors are caught and their messages assigned to local state, but never logged or reported to any monitoring service. If any of these operations fail in production, there is zero record of what happened.
- **Remediation Plan:** Replace all bare `catch {}` blocks with proper error handling that: (1) logs the error to `console.error` at minimum, (2) sends it to an error reporting service like Sentry once integrated, and (3) surfaces a meaningful message to the user. Create a centralized error reporting utility at `src/lib/error-reporter.ts` that all catch blocks call. Never swallow errors — always log them even if the UI shows a graceful fallback.

---

### Item 9 — Missing Accessibility (WCAG) Compliance

- **Category:** Architectural Debt
- **Description:** The application has significant accessibility gaps. In `src/routes/submit.tsx` line 387, radio inputs for funding source selection use `className="sr-only"` but lack `<label>` or `aria-label` attributes, making them invisible to screen readers. In `submit.tsx` line 406, the file upload input has no `aria-label` or associated label element. In `src/routes/requests.tsx` line 52, the search input has no `aria-label`. In `src/routes/login.tsx` lines 202 and 215, form inputs are missing associated `<label>` elements — they use custom styled placeholders but no accessible labels. The `src/components/AppHeader.tsx` mobile hamburger menu button (line 23) has no `aria-label` or `aria-expanded` attribute. None of the route transitions announce navigation changes to screen readers. Focus management is not handled when dialogs open or close in `RequestDetailDialog.tsx`.
- **Remediation Plan:** Audit every form input and interactive element for WCAG 2.1 AA compliance. Add `aria-label` attributes to all inputs that lack visible labels. Add `aria-label="Open navigation menu"` and `aria-expanded` to the hamburger button. Add `aria-live` regions for dynamic content updates (form errors, request status changes). Use the installed but unused `@radix-ui/react-dialog` component for the request detail dialog, which handles focus trapping automatically. Run an automated accessibility audit with axe-core.

---

### Item 10 — No Pagination or Query Limits on Database Reads

- **Category:** Architectural Debt
- **Description:** The `useFinancialRequests` hook in `src/lib/requests-data.ts` (lines 88–91) executes `.select("*").order("created_at", { ascending: false })` against the `financial_requests` table with no `.limit()` or `.range()` clause. This pulls every row in the table into the browser on every page load. As the system accumulates requests over time, this query will become progressively slower, consume more bandwidth, and potentially crash the browser tab if thousands of rows are returned. The overview page (`index.tsx` line 42) then slices to `requests.slice(0, 6)` to show 6 items — meaning 994 of 1000 rows would be fetched and discarded. The requests listing page (`requests.tsx`) similarly loads all data and filters client-side.
- **Remediation Plan:** Add `.range(0, 49)` to the Supabase query to implement cursor-based pagination (50 rows per page). Add a "Load More" button or infinite scroll on the requests page. For the overview dashboard, use a separate query with `.limit(6)`. Move search and filtering logic to the database (Supabase supports `.ilike()`, `.eq()`, `.in()`) rather than loading all data and filtering in JavaScript.

---

### Item 11 — Hardcoded Currency and Date Formatting (No Internationalization)

- **Category:** Documentation Debt
- **Description:** Currency values are formatted using a hardcoded template string `` `$${amount.toLocaleString()}` `` copy-pasted across at least 5 separate files: `src/routes/analytics.tsx` (line 38), `src/routes/tracking.tsx` (line 87), `src/routes/requests.tsx` (line 126), `src/routes/index.tsx` (line 94), and `src/components/RequestDetailDialog.tsx` (line 38). This hardcodes USD currency and the dollar sign without using the `Intl.NumberFormat` API. Date formatting in `src/routes/submit.tsx` (line 169) uses `new Date().toISOString().slice(0, 10)`, which ignores the user's local timezone and could produce incorrect dates near midnight. Date strings from the database are displayed by slicing ISO strings (`row.created_at.slice(0, 10)` in requests-data.ts line 61) rather than using locale-aware formatting.
- **Remediation Plan:** Create a `src/lib/format.ts` utility with `formatCurrency(amount: number)` using `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })` and `formatDate(date: string)` using `Intl.DateTimeFormat`. Replace all hardcoded formatting across the 5+ files with calls to these shared utilities. This also eliminates the code duplication issue.

---

### Item 12 — No Rate Limiting or Brute-Force Protection

- **Category:** Architectural Debt
- **Description:** The login page (`src/routes/login.tsx` line 43) calls `auth.signIn(email, password)` with zero client-side throttling, rate limiting, or CAPTCHA protection. A malicious actor can programmatically submit thousands of login attempts per second to brute-force credentials. Similarly, the submit form (`src/routes/submit.tsx` line 220) allows unlimited rapid submissions — there is no debounce, cooldown timer, or duplicate submission detection. While Supabase has some built-in rate limiting on their auth endpoints, the application does nothing to prevent abuse on its side, and the prototype localStorage fallback (which has zero server-side controls) can be spammed infinitely.
- **Remediation Plan:** Add a client-side rate limiter to the login form: disable the submit button for 3 seconds after a failed attempt, with exponentially increasing delays. Add a CAPTCHA (e.g., hCaptcha or Cloudflare Turnstile) after 3 failed login attempts. Add a debounce and duplicate-detection mechanism to the submit form. Configure Supabase Auth rate limiting in the dashboard. Consider implementing a Supabase Edge Function for form submission that enforces server-side rate limits.

---

### Item 13 — Zero Structured Logging or Error Monitoring

- **Category:** Documentation Debt
- **Description:** The entire codebase has no logging infrastructure. There are zero `console.error` calls in error paths, no integration with error tracking services (Sentry, LogRocket, Datadog), no structured log format, and no way to diagnose production issues. When a database query fails, the error is either swallowed in a bare catch block or stored in local React state that vanishes on refresh. When the prototype fallback activates, there is no server-side record that it happened. When a file upload fails, the only evidence is a transient warning banner. If users report issues, the team has no logs, no error traces, and no way to reproduce problems.
- **Remediation Plan:** Install Sentry (`@sentry/react`) and initialize it in `src/routes/__root.tsx`. Wrap the application in Sentry's `ErrorBoundary` component. Add `Sentry.captureException(error)` calls to all catch blocks. Create a logging utility at `src/lib/logger.ts` with structured log levels (info, warn, error) that outputs to both the console and Sentry. Add Sentry's performance monitoring to track page load times and slow Supabase queries.

---

### Item 14 — Unrestricted File Upload with No Validation

- **Category:** Architectural Debt
- **Description:** The file upload input in `src/routes/submit.tsx` (line 406) uses `<input type="file" multiple>` with no `accept` attribute, no MIME type validation, and no file size limit. Users can upload any file type including `.exe`, `.bat`, `.html`, `.svg`, or `.sh`. SVG files can contain embedded JavaScript that executes when viewed by an admin or reviewer — a stored XSS attack vector. The file name sanitization (line 239, `file.name.replace(/[^a-zA-Z0-9._-]/g, "-")`) preserves dangerous extensions. There is no maximum file count validation — a user could select hundreds of files. The only constraint is Supabase storage's bucket-level limits, which are not configured in the migration.
- **Remediation Plan:** Add an `accept` attribute to the file input restricting uploads to safe document types (`.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg`). Add client-side validation before upload: check `file.type` against an allowlist of MIME types, enforce a maximum file size (10MB per file), and limit the number of files (e.g., max 10). Add a Supabase storage policy that rejects disallowed file types server-side as a second layer of defense.

---

### Item 15 — `dangerouslySetInnerHTML` XSS Vulnerability

- **Category:** Architectural Debt
- **Description:** In `src/routes/login.tsx` line 162, the TOTP setup QR code is rendered using `dangerouslySetInnerHTML={{ __html: setup.qrCode }}`, injecting raw HTML/SVG from the Supabase MFA API directly into the DOM without sanitization. If the MFA response were compromised or modified by a man-in-the-middle attack, arbitrary scripts could execute in the user's browser. In `src/components/ui/chart.tsx` line 73, the chart tooltip component also uses `dangerouslySetInnerHTML` to render custom chart content. Both usages bypass React's built-in XSS protections and introduce injection risk.
- **Remediation Plan:** Replace the `dangerouslySetInnerHTML` QR code rendering with a dedicated QR library (e.g., `qrcode.react`) that generates safe DOM elements from the TOTP secret URI rather than rendering raw SVG HTML. If raw HTML injection is absolutely necessary, sanitize it first with DOMPurify (`DOMPurify.sanitize(htmlString)` before passing to `dangerouslySetInnerHTML`). Audit all other usages of `dangerouslySetInnerHTML` in the shadcn chart component.

---

### Item 16 — Auth Tokens Stored in localStorage Instead of HttpOnly Cookies

- **Category:** Architectural Debt
- **Description:** The Supabase client in `src/integrations/supabase/client.ts` (line 19) explicitly configures auth token storage to use `localStorage`: `storage: typeof window !== 'undefined' ? localStorage : undefined`. This means the user's JWT auth token is accessible to any JavaScript running on the page, including third-party scripts, browser extensions, or XSS payloads. If an attacker exploits any of the identified XSS vulnerabilities (dangerouslySetInnerHTML, SVG file uploads), they can steal the auth token from localStorage and impersonate the user. Additionally, prototype financial request data is stored in localStorage (submit.tsx lines 139, 156), mixing sensitive financial data with browser storage that persists across sessions and is accessible to any script.
- **Remediation Plan:** Configure the Supabase client to use cookie-based session storage by leveraging `@supabase/ssr` with `createBrowserClient` instead of the standard client. This stores tokens in HttpOnly cookies that JavaScript cannot access. Remove all financial data from localStorage — prototype requests should be stored server-side or not at all. Implement CSRF protection if switching to cookie-based auth.

---

### Item 17 — Missing Security Headers in Build and Deployment Configuration

- **Category:** Documentation Debt
- **Description:** Neither `vite.config.ts` nor `wrangler.jsonc` configures any HTTP security headers. There is no Content Security Policy (CSP) header to prevent inline script injection. There is no `Strict-Transport-Security` (HSTS) header to enforce HTTPS. There is no `X-Frame-Options` header to prevent clickjacking. There is no `X-Content-Type-Options: nosniff` header. The build configuration does not explicitly disable source maps for production, meaning the full source code and file structure could be visible in browser developer tools in production.
- **Remediation Plan:** Add security headers to `wrangler.jsonc` or create a Cloudflare Pages `_headers` file with: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. Add `build: { sourcemap: false }` to the Vite config for production builds.

---

### Item 18 — Duplicated Currency Formatting Logic Across 5+ Files

- **Category:** Documentation Debt
- **Description:** The exact same currency formatting pattern `` `$${amount.toLocaleString()}` `` or `` `$${req.amount.toLocaleString()}` `` is copy-pasted across at least 5 files: `src/routes/analytics.tsx`, `src/routes/tracking.tsx`, `src/routes/requests.tsx`, `src/routes/index.tsx`, and `src/components/RequestDetailDialog.tsx`. Similarly, status-to-CSS-class mapping logic is duplicated across StatusBadge and inline styling in multiple routes. The `isTransientBackendError` retry logic pattern also appears in both `src/routes/submit.tsx` (lines 75–99) and `src/lib/auth-context.tsx` (lines 41–59) with slightly different implementations. This duplication violates DRY principles and means bug fixes or format changes must be applied to every copy individually.
- **Remediation Plan:** Create `src/lib/format.ts` with shared `formatCurrency`, `formatDate`, and `formatStatus` utilities. Create `src/lib/retry.ts` with a single `withRetry` utility that both the auth context and submit form use. Replace all 5+ duplicated formatting patterns with calls to the shared utilities. Add a linting rule or code review checklist item to prevent future duplication.

---

### Item 19 — Installed But Unused Validation Framework (react-hook-form)

- **Category:** Architectural Debt
- **Description:** The project has `react-hook-form` (v7.72.1) and `@hookform/resolvers` (v5.2.2) installed as dependencies in `package.json`. A complete `src/components/ui/form.tsx` shadcn component integrates these packages with proper validation, error display, and accessibility support. However, the actual submit form in `src/routes/submit.tsx` completely ignores this — it uses manual `FormData` extraction from `event.currentTarget`, runs `requestSchema.safeParse()` manually, and manages errors in a `useState<Partial<Record<string, string>>>`. The login form in `login.tsx` similarly uses raw `useState` for each field instead of react-hook-form. This means the project has a proper form validation framework installed, configured, and wrapped in a UI component — but every form was built from scratch instead.
- **Remediation Plan:** Decide whether to adopt react-hook-form or remove it. If adopting: refactor `submit.tsx` to use `useForm()` with the `zodResolver` (from `@hookform/resolvers/zod`) and the existing `requestSchema`. Replace inline error state with react-hook-form's built-in `formState.errors`. Use the existing `src/components/ui/form.tsx` wrapper components. If not adopting: uninstall `react-hook-form` and `@hookform/resolvers`, and delete `src/components/ui/form.tsx`.

---

### Item 20 — Missing Database Foreign Key Constraints

- **Category:** Architectural Debt
- **Description:** In the Supabase migration file (`supabase/migrations/20260428002922_0ba291ef-6600-4926-9100-0a908f77852c.sql`), the `profiles.user_id`, `user_roles.user_id`, and `financial_requests.user_id` columns store UUID references to `auth.users(id)` but lack explicit `REFERENCES auth.users(id)` foreign key constraints. This means: (1) if a user is deleted from Supabase Auth, their profile, roles, and financial requests become orphaned rows with invalid `user_id` values that will never be cleaned up; (2) there is no `ON DELETE CASCADE` to automatically remove dependent records; (3) data integrity cannot be enforced at the database level — the application could theoretically insert requests with non-existent `user_id` values.
- **Remediation Plan:** Create a new migration that adds foreign key constraints: `ALTER TABLE profiles ADD CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`. Apply the same for `user_roles` and `financial_requests`. Test that deleting a user in Supabase Auth cleanly cascades to remove all dependent records.

---

### Item 21 — Router Missing Loading States and Prefetching Disabled

- **Category:** Architectural Debt
- **Description:** In `src/router.tsx` line 62, the router is configured with `defaultPreloadStaleTime: 0`, which disables route prefetching — meaning every navigation requires a full page load with no preloading. None of the 7 route definitions include `pendingComponent` configurations, so route transitions show blank white screens while data loads. The root layout in `__root.tsx` (lines 79–82) uses `useEffect` with `window.location.href = "/login"` for auth redirects instead of TanStack Router's native `beforeLoad` redirect — this causes a full page reload and a flash of unauthenticated content. There are no route-level `errorComponent` definitions — any unhandled error in any route crashes the entire application to a full-screen error page.
- **Remediation Plan:** Set `defaultPreloadStaleTime` to a reasonable value (e.g., 30000ms) to enable route prefetching on hover. Add `pendingComponent` to each route that shows a loading skeleton. Replace the `useEffect`/`window.location.href` auth redirect with TanStack Router's `beforeLoad` function that throws a `redirect({ to: "/login" })`. Add route-level `errorComponent` definitions that show contextual error messages without crashing the entire app.

---

### Item 22 — Mobile Navigation Completely Non-Functional

- **Category:** Architectural Debt
- **Description:** In `src/components/AppHeader.tsx` line 23, a hamburger menu button is rendered with `className="lg:hidden"` (visible only on mobile screens), but the button has no `onClick` event handler — clicking it does nothing. The sidebar component in `src/components/AppSidebar.tsx` line 30 is permanently set to `className="hidden lg:flex"`, meaning it is always hidden on mobile screens with no mechanism to show it. Together, this means that on any screen smaller than `lg` (1024px), users have no way to navigate between pages. The sidebar links (Overview, Submit, Requests, Tracking, Analytics) are completely inaccessible on mobile devices.
- **Remediation Plan:** Add a `useState` to `AppHeader.tsx` to track mobile menu open/closed state. Wire the hamburger button's `onClick` to toggle this state. Make `AppSidebar.tsx` accept an `isOpen` prop and conditionally render with a slide-in animation on mobile. Add a backdrop overlay that closes the sidebar when clicked. Alternatively, use the installed but unused `Sheet` component from `src/components/ui/sheet.tsx` which provides a pre-built slide-out panel with accessibility support.

---

### Item 23 — No Runtime Validation of Environment Variables

- **Category:** Documentation Debt
- **Description:** In `src/integrations/supabase/client.ts` (lines 8–13), environment variables are read with a simple `||` fallback and a basic `if (!SUPABASE_URL)` check that throws a generic error. There is no structured validation of the environment variable format (e.g., is the URL actually a valid URL? Does the key look like a JWT?). There is no `.env.example` file documenting required variables. If a developer clones the repo without the `.env` file, they get an opaque "Missing Supabase environment variables" error with no guidance on what to set. The `VITE_SUPABASE_PROJECT_ID` variable in `.env` is defined but never referenced in any code.
- **Remediation Plan:** Create a `src/lib/env.ts` module that uses Zod to validate all environment variables at app startup: `z.object({ VITE_SUPABASE_URL: z.string().url(), VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(100) })`. Import and call this validation in the Supabase client initialization. Create a `.env.example` file listing all required variables with placeholder values and inline comments. Remove the unused `VITE_SUPABASE_PROJECT_ID` variable.

---

### Item 24 — Memory Leaks from Orphaned Event Listeners and Dangling Timeouts

- **Category:** Architectural Debt
- **Description:** In `src/components/ui/carousel.tsx` (lines 99–100), the component registers two event listeners on the carousel API: `api.on("reInit", onSelect)` and `api.on("select", onSelect)`. The cleanup function on line 103 only removes `"select"` — the `"reInit"` listener is never unsubscribed, causing a memory leak every time the component mounts and unmounts. In `src/lib/auth-context.tsx` line 127, `window.setTimeout(() => { void loadProfile(...); void refreshMfaState(); }, 0)` is called without storing the timeout ID or clearing it on unmount — if the component unmounts before the timeout fires, state updates will be attempted on an unmounted component. In `src/hooks/use-mobile.tsx`, a `matchMedia` listener is registered but the hook is only imported by the dead code in `ui/sidebar.tsx`.
- **Remediation Plan:** Fix the carousel cleanup to remove both listeners: `api.off("reInit", onSelect)` and `api.off("select", onSelect)`. Store the timeout ID from `window.setTimeout` in a `useRef` and clear it in a cleanup function: `return () => clearTimeout(timeoutRef.current)`. Review all `useEffect` hooks for proper cleanup returns. Add a React StrictMode wrapper in development to catch these issues automatically.

---

### Item 25 — No CI/CD Pipeline, Health Checks, or Deployment Automation

- **Category:** Documentation Debt
- **Description:** The project has no `.github/workflows` directory and no CI/CD pipeline of any kind. There is no automated linting, building, or testing on pull requests. There is no automated deployment — the team must manually deploy to Cloudflare Pages. There are no health check endpoints for uptime monitoring. There is no staging environment for testing changes before they reach production. The `wrangler.jsonc` configuration exists for Cloudflare deployment but no deployment scripts or commands are documented. The project cannot be verified to build successfully without manually running `npm run build` locally.
- **Remediation Plan:** Create a `.github/workflows/ci.yml` that runs `npm ci`, `npm run lint`, `npm run build`, and `npm test` on every pull request. Add a deployment workflow that deploys to Cloudflare Pages on merge to `main`. Add a health check route at `/api/health` that returns 200 with a timestamp. Set up a staging environment with a separate Supabase project. Document the deployment process in the README.

---

## Part 2: AI & System Risk Assessment

### Risk 1 — AI Hallucinated a Broken Migration Then Generated Elaborate Workarounds

- **Category:** Reliability / Hallucination
- **Description:** The Lovable.dev AI generated two sequential Supabase migrations. The first migration creates RLS policies that depend on `has_role()` and `is_admin_or_reviewer()` security-definer functions. The second migration, generated moments later, revokes `EXECUTE` permissions on those exact functions from the `authenticated` role. This creates a contradiction: RLS policies call functions that users don't have permission to execute, causing every authenticated database query to fail with `permission denied`. Rather than surfacing this error, the AI then generated elaborate workarounds: a `transientBackendCodes` error classifier, an `isTransientBackendError` function, an exponential-backoff retry loop with 6 attempts and up to 8-second delays, and an entire localStorage prototype fallback system — treating a self-inflicted schema bug as a "transient backend error." The AI essentially hallucinated a problem and then hallucinated an increasingly complex set of band-aids to hide it.
- **Remediation Plan:** Create a corrective migration that grants `EXECUTE` on both helper functions to the `authenticated` role. Verify RLS policies work by testing queries as an authenticated user. Once confirmed, simplify or remove the retry logic and eliminate the localStorage fallback entirely. Establish a review protocol where all AI-generated migrations are tested against a staging database before deployment.

---

### Risk 2 — AI Bulk-Installed 46 Components Without Human Review

- **Category:** Reliability / Hallucination
- **Description:** The Lovable.dev AI ran a bulk installation of the entire shadcn/ui component library (46 files, ~4,000 lines, ~140KB) into `src/components/ui/` without verifying which components the application actually needed. It then proceeded to build every form, dialog, and input from scratch using inline JSX instead of using any of the installed components. This represents an AI "hoarding" pattern — installing everything available rather than selecting what's needed. The human developer never reviewed this bulk installation. The AI also installed 12+ npm packages (including `framer-motion` at 500KB+) that are never imported. This bloats the project, confuses developers trying to understand the architecture, and increases the attack surface with unnecessary dependency code.
- **Remediation Plan:** Have a human developer review every file in `src/components/ui/`. Delete components that will never be used. For the remaining ones, migrate inline UI code to use them. Establish a review protocol: never accept bulk installations from AI — review each added dependency individually. Add `npm audit` to the CI pipeline.

---

### Risk 3 — AI Disabled TypeScript and ESLint Safety Checks

- **Category:** Reliability / Hallucination
- **Description:** The AI generator configured `tsconfig.json` with `noUnusedLocals: false` and `noUnusedParameters: false` (lines 19–20), and set `@typescript-eslint/no-unused-vars: "off"` in `eslint.config.js` (line 24). This means dead code, unused imports, and unreferenced variables generate zero warnings or errors. These safety checks exist specifically to catch the exact problems this codebase has (46 unused component files, 12 unused packages, orphaned server-side files). The AI turned them off to suppress its own mess rather than cleaning it up. This is a systematic undermining of the "trust but verify" principle — the AI made verification tools unable to detect its own quality issues.
- **Remediation Plan:** Re-enable all three settings immediately. Run the build and linter to generate the full list of unused code. Address each warning — either use the code or delete it. Never allow AI to modify linting or compiler strictness settings without explicit human approval.

---

### Risk 4 — AI Generated Pre-Filled Demo Credentials in Production Code

- **Category:** Security & Ethics
- **Description:** The login page (`src/routes/login.tsx` lines 20–23) initializes React state with real-looking demo credentials: `faculty@howard.edu`, `SecurePass123!`, `Dr. Sarah Chen`, `Chemistry`. These values are not behind a feature flag, environment variable, or development-only check — they ship in every build, including production. Any user who views the login page sees pre-filled credentials that could be used to access the system if the account exists. Any developer or security auditor who views the source code sees a plaintext password. The AI generated these for a visually complete demo without considering the security implications of shipping credentials in client-side code.
- **Remediation Plan:** Replace all default state values with empty strings: `useState("")`. Use `placeholder` attributes on the inputs to show example text that isn't submitted. If demo mode is needed for presentations, gate it behind an environment variable (`VITE_DEMO_MODE=true`) and only pre-fill in development builds.

---

### Risk 5 — AI Generated localStorage as a "Database" Fallback

- **Category:** Reliability / Hallucination
- **Description:** When the database insert fails (due to the AI's own broken migration), the AI generated a localStorage-based fallback system (`savePrototypeRequest`, `savePrototypeAttachments` in submit.tsx lines 131–157) that silently stores financial requests in the browser. The AI then generated data-fetching code (`requests-data.ts` lines 103–104) that merges these localStorage records with real database rows, making them appear identical in the UI. This creates a situation where a user believes they submitted a financial request, but the data only exists in their browser's localStorage — it will be lost if they clear their cache, switch browsers, or use a different computer. The AI hallucinated a "solution" that creates data loss risk for financial documents.
- **Remediation Plan:** Remove the entire prototype fallback system. If the database is unavailable, show a clear error message telling the user to try again later. Never silently degrade from a database to browser storage for financial records. Implement proper offline support via a service worker with a sync queue if offline capability is genuinely required.

---

### Risk 6 — AI Chose localStorage for Auth Token Storage

- **Category:** Security & Ethics
- **Description:** The Supabase client configuration (`src/integrations/supabase/client.ts` line 19) uses `storage: typeof window !== 'undefined' ? localStorage : undefined` for auth token persistence. The AI selected localStorage as the storage mechanism rather than HttpOnly cookies. Tokens in localStorage are accessible to any JavaScript on the page, making them vulnerable to theft via XSS attacks. Combined with the `dangerouslySetInnerHTML` vulnerability in login.tsx and the unrestricted file uploads, an attacker could inject JavaScript that reads `localStorage.getItem("supabase.auth.token")` and exfiltrates the token to steal the user's session.
- **Remediation Plan:** Migrate to `@supabase/ssr` with cookie-based session storage. Configure HttpOnly, Secure, SameSite cookies for auth tokens. This removes the token from JavaScript access entirely. Implement CSRF protection as a complementary measure.

---

### Risk 7 — AI Generated Server-Side Files That Are 100% Orphaned

- **Category:** Reliability / Hallucination
- **Description:** The AI generated two server-side integration files — `src/integrations/supabase/auth-middleware.ts` (78 lines) and `src/integrations/supabase/client.server.ts` (38 lines) — that implement TanStack Start server middleware and a server-side Supabase client with the service role key. Neither file is imported or referenced anywhere in the application. The project has `wrangler.jsonc` configured for Cloudflare Workers SSR, but no server functions (`createServerFn`) exist. The AI scaffolded a server-side architecture and then built everything as a client-side SPA instead, leaving dead server infrastructure that confuses developers into thinking the app has server-side capabilities it doesn't. The `client.server.ts` file also references `process.env.SUPABASE_SERVICE_ROLE_KEY` — a secret key that should never be mentioned in client-accessible code even if the file is currently unused.
- **Remediation Plan:** Delete `auth-middleware.ts` and `client.server.ts` since they are completely unused. If server-side rendering is needed in the future, rebuild these files intentionally with proper architecture planning. Remove any references to `SUPABASE_SERVICE_ROLE_KEY` from client-accessible code.

---

### Risk 8 — AI-Generated Code Lacks Any Documentation or Comments

- **Category:** Reliability / Hallucination
- **Description:** Not a single `/** JSDoc */` comment, inline explanation, or function documentation exists in the entire `src/` directory. The only comments are Lovable-generated boilerplate: "This file is auto-generated by Lovable. Do not modify it." (lovable/index.ts line 1) and "This file is automatically generated. Do not edit it directly." (supabase/client.ts line 1, client.server.ts line 1). Complex business logic — like why `principalInvestigator` auto-prepends "Dr." (submit.tsx line 34), why retry logic uses `Math.min(800 * 2 ** attempt, 8000)` (submit.tsx line 121), or why the role defaults to "admin" (app-context.tsx line 17) — has zero explanation. A new team member joining the project has no way to understand design decisions, edge cases, or the reasoning behind any code path without reverse-engineering it.
- **Remediation Plan:** Add JSDoc comments to all exported functions, hooks, and types. Document the "why" — not just the "what" — for non-obvious logic. Add a `README.md` to the project root with setup instructions, architecture overview, and a link to the architecture diagram. Add inline comments for business rules (e.g., why Howard email is enforced, why "Dr." is prepended, how the routing map works).

---

### Risk 9 — No "Trust But Verify" Protocol for AI-Generated Output

- **Category:** Reliability / Hallucination
- **Description:** The project was generated by Lovable.dev's AI and has been modified by Google Antigravity, but there is no systematic verification process in place. No automated tests exist to verify that AI-generated code behaves correctly. No code review checklist exists for reviewing AI output. No integration tests validate that the Supabase queries return expected data shapes. The Zod schema (the only validation in the system) was never tested against edge cases. The AI-generated RLS migration was never tested against a staging database. The AI-generated shadcn component bulk-install was never audited. The AI-generated retry logic was never verified to handle the error codes it claims to handle. The entire system runs on blind trust that the AI produced correct, secure, and complete code.
- **Remediation Plan:** Establish a VIBE coding protocol: (1) Verify — run tests and lint checks on all AI output before accepting; (2) Improve — refactor AI code to meet team standards; (3) Build — add test coverage for every accepted AI contribution; (4) Execute — deploy only after CI passes. Create a checklist for AI code review: check for `as any` casts, bare catch blocks, hardcoded values, disabled lint rules, unused imports, and security vulnerabilities.

---

### Risk 10 — AI Optimized for Visual Completeness, Not Production Security

- **Category:** Security & Ethics
- **Description:** The Lovable.dev AI generator prioritized making the application look complete and functional in a demo — it generated a login page with pre-filled credentials, a notification dropdown with fake data, analytics charts with hardcoded numbers, a role switcher that lets anyone become admin, and a file upload with no restrictions. All of these create a visual impression of a fully functional system while hiding fundamental security gaps. The demo password `SecurePass123!` in the login form, the admin-default role, the unrestricted file uploads, and the localStorage financial data storage are all optimizations for demo aesthetics at the expense of production security. An uninformed stakeholder viewing this prototype would believe it is secure and functional when it is neither.
- **Remediation Plan:** Audit every user-facing feature for the gap between appearance and reality. Remove all demo shortcuts (pre-filled credentials, mock data, client-side role switching). Replace visual-only features with real implementations. Add a visible "PROTOTYPE" banner in non-production builds so stakeholders understand the system's maturity level. Never demo a system without disclosing its limitations.

---

### Risk 11 — AI Hallucinated Mobile Responsiveness

- **Category:** Reliability / Hallucination
- **Description:** The AI generated a mobile-responsive layout skeleton — a hamburger menu button with `lg:hidden` in `AppHeader.tsx` (line 23) and a sidebar with `hidden lg:flex` in `AppSidebar.tsx` (line 30). This creates the visual impression that mobile navigation was implemented. However, the hamburger button has no `onClick` handler — it is a non-functional button. The sidebar is permanently hidden on mobile with no way to reveal it. The AI generated the UI elements for responsiveness but never wired them together, leaving mobile users with no navigation. This is a hallucination of functionality — the code looks correct at a glance but doesn't work.
- **Remediation Plan:** Wire the hamburger button to a state-driven sidebar toggle. Use either a `useState` approach or the installed `Sheet` component from shadcn/ui. Test the navigation on actual mobile viewports before considering the feature complete.

---

### Risk 12 — Dependency on AI-Managed Supabase Type Generation

- **Category:** Dependency Risk
- **Description:** The Supabase database type definitions (`src/integrations/supabase/types.ts`, 383 lines) are auto-generated and marked as "Do not edit it directly." These types define the TypeScript interface for every table, column, and relationship. If the database schema changes (new columns, renamed tables, altered types), these types must be regenerated using `supabase gen types typescript`. However, the AI bypasses these types entirely (using `as any`), so there is currently no mechanism to detect when the types are stale or mismatched with the actual schema. If a future developer relies on these types without regenerating them, they could write code that compiles successfully but fails at runtime because the types don't match the current database.
- **Remediation Plan:** Add a `"types:generate": "supabase gen types typescript --project-id $VITE_SUPABASE_PROJECT_ID > src/integrations/supabase/types.ts"` script to `package.json`. Run it after every migration. Remove all `as any` casts so type mismatches surface as compile errors immediately. Add type generation to the CI pipeline.

---

### Risk 13 — Lovable.dev Vendor Lock-in Creates Single Point of Failure

- **Category:** Dependency Risk
- **Description:** The project depends on two proprietary Lovable.dev packages that cannot be replaced without significant refactoring: (1) `@lovable.dev/cloud-auth-js` powers the Google OAuth sign-in flow — the `signInWithGoogle` function in `auth-context.tsx` (line 177) routes through `lovable.auth.signInWithOAuth("google", ...)` instead of using Supabase's native `supabase.auth.signInWithOAuth()`. If Lovable changes their auth API, deprecates the package, or alters pricing, Google sign-in breaks entirely. (2) `@lovable.dev/vite-tanstack-config` wraps the entire Vite build configuration — `vite.config.ts` consists of a single line: `export default defineConfig()` from Lovable's package. This means the team cannot customize Vite plugins, adjust build settings, add environment-specific configurations, or debug build issues without reverse-engineering what Lovable's opaque wrapper does. The project cannot be built without these proprietary packages, creating a single point of failure tied to an external company's platform.
- **Remediation Plan:** Replace `lovable.auth.signInWithOAuth` with Supabase's native `supabase.auth.signInWithOAuth({ provider: "google" })`, which is already documented and supported. Uninstall `@lovable.dev/cloud-auth-js` and delete `src/integrations/lovable/index.ts`. Replace `@lovable.dev/vite-tanstack-config` with a standard `vite.config.ts` that explicitly configures `@vitejs/plugin-react`, `vite-tsconfig-paths`, `@tanstack/router-plugin/vite`, `@tailwindcss/vite`, and `@cloudflare/vite-plugin`. This eliminates both vendor lock-in dependencies and gives the team full control over the build pipeline.

---

### Risk 14 — Client-Side Role Switching Defaults to Admin

- **Category:** Security & Ethics
- **Description:** In `src/lib/app-context.tsx` (line 17), the application role state is initialized to `"admin"` by default: `const [role, setRole] = useState<UserRole>("admin")`. Until the auth context loads and overrides this, every user temporarily has admin-level UI access. Furthermore, the `AppHeader.tsx` component renders a client-side role switcher dropdown that allows any authenticated user to change their role to "admin" or "leadership" in the browser, granting access to UI elements that should be restricted. While RLS policies on the database side would block unauthorized data access (if they were working — see Risk 1), the UI still exposes admin workflows, review actions, and sensitive dashboard data to unauthorized users. The AI generated this as a developer convenience tool for prototyping but it ships in production.
- **Remediation Plan:** Change the default role initialization from `"admin"` to `"requester"`. Remove the client-side role switcher from `AppHeader.tsx` in production — it was generated as a demo/prototyping convenience. Derive the user's role solely from the database `user_roles` table via the auth context. Implement route-level guards using TanStack Router's `beforeLoad` to redirect unauthorized users before the route renders.

---

### Risk 15 — No Server-Side Validation Creates Complete Bypass Risk

- **Category:** Security & Ethics
- **Description:** All data validation in the system runs exclusively on the client side via the Zod `requestSchema` in `submit.tsx`. There are no Supabase Edge Functions, database triggers, or server-side middleware that validate input data. This means any user with basic developer tools knowledge can bypass the Zod schema entirely by calling the Supabase REST API directly: `fetch("https://vqccflhdudodyjxqjfoq.supabase.co/rest/v1/financial_requests", { method: "POST", body: ... })` with an invalid email, negative amount, past date, or any other violating data. The Howard email enforcement (`@howard.edu`), amount limits, date validation, conditional field requirements, and the "Dr." auto-prepend are all purely cosmetic protections that disappear when the form is bypassed. The Supabase publishable (anon) key is embedded in the client-side JavaScript and visible to anyone.
- **Remediation Plan:** Create a Supabase Edge Function or database trigger that validates all financial request inserts and updates server-side. Mirror the Zod schema rules in PostgreSQL `CHECK` constraints where possible (e.g., `CHECK (amount > 0 AND amount < 9999999)`, `CHECK (requester_email LIKE '%@howard.edu')`). Add a `BEFORE INSERT` trigger for complex validation like conditional field requirements. The client-side Zod validation should remain for UX purposes, but the server must be the authoritative validation layer.

---

## Part 3: Backlog Integration

Based on the audit above, the top 3 items to convert into GitHub Issues on the project board are:

1. **Item 5 — `.env` File Not Gitignored and Hardcoded Demo Credentials** → Create an issue tagged `technical-debt` + `security`. This is the most immediately actionable and highest-risk item.

2. **Item 2 — Zero Automated Test Coverage** → Create an issue tagged `technical-debt`. This blocks the ability to safely refactor any other debt item.

3. **Item 1 — Monolithic Route Files with No Separation of Concerns** → Create an issue tagged `refactor`. This is the foundational architectural change that enables all future feature work.
