# Module 9 — Test Coverage Report

**Project:** Financial Request Management System (FinReq)  
**Team:** Group 3  
**Prepared by:** Nylah Rogers  
**Repository:** https://github.com/jjoiles/Financial_Management_System_Group3  
**Branch:** `test/module9-power-automate-coverage`  
**Related feature:** F7 — Power Automate Workflow Initialization  
**Report status:** Test changes prepared; full-suite execution and CI verification pending

## 1. Purpose

Module 9 asks the team to improve unit/integration testing and use AI to help generate tests, then validate those tests. This change targets the Power Automate client helpers because they build the outbound workflow payload, sign requests, enforce HTTPS, and handle HTTP/network failures and retry behavior.

## 2. Baseline inspection

The `main` branch snapshot inspected for this task contained:
- 19 existing Vitest test files.
- No dedicated test file for `src/lib/workflow/power-automate.ts`.
- The Power Automate module explicitly describes its helpers as pure and independently testable.
- The F7 documentation defines the outbound event, payload fields, secure flow URL expectations, HMAC signing, idempotency, retry behavior, and simulated/live workflow distinction.

This is a targeted test-gap assessment, not a repository-wide line-coverage measurement.

## 3. Scope added

New test file: `src/lib/workflow/power-automate.test.ts`

The tests cover these behavior groups:

| Behavior group | Test cases |
|---|---:|
| Payload mapping, optional Research fields, app URL construction | 5 |
| HMAC-SHA256 signing and signature changes | 2 |
| HTTPS allowlist and invalid URL handling | 4 |
| Reject non-HTTPS flow URL before network access | 1 |
| Successful POST and response run ID handling | 2 |
| Outbound headers and optional signature header | 2 |
| Non-retryable 4xx response handling | 1 |
| Retry on 429 and 5xx responses | 2 |
| Retry on network errors | 1 |
| Timeout/AbortError reporting | 1 |
| Retry exhaustion and final response reporting | 1 |
| **Total** | **22** |

## 4. AI-assisted test development and validation approach

AI assistance was used to draft test scenarios from the actual F7 implementation and its repository documentation. Expected values were checked against:
- `src/lib/workflow/power-automate.ts` (implementation under test).
- `docs/F7_Power_Automate_Workflow.md` (feature contract and manual verification guidance).
- The request and routing type definitions used by the payload builder.

Tests use injected `fetchImpl` and `sleep` functions so retry cases are deterministic and do not call a live Power Automate endpoint or wait through real backoff delays. The signature test independently computes the HMAC-SHA256 expected value using Node's crypto implementation.

The suite uses controlled response objects, including success, 4xx, 429, 5xx, network rejection, and timeout abort cases. No production endpoint, secret, user account, or live workflow is required.

## 5. Execution status

| Check | Status |
|---|---|
| Test cases authored | 21 |
| Target module has a dedicated test file | Yes |
| Expected payload mapped to F7 contract | Reviewed against repository docs/source |
| Network and retry behavior isolated with test doubles | Yes |
| Targeted Vitest execution | **Pending local/CI run** |
| Full `npm test` | **Pending local/CI run** |
| `npx tsc --noEmit` | **Pending local run** |
| `npm run build` | **Pending local run** |
| Browser/live Power Automate verification | Not part of this unit-test PR |

### Coverage percentage

A numeric line/branch coverage percentage is **not reported**. The inspected repository configuration does not show an installed Vitest coverage provider or an existing coverage script on `main`. The 22 cases are test-count evidence, not a claim of 100% line or branch coverage. Configure a compatible provider before publishing numerical coverage percentages.

## 6. Commands to run before merge

From the repository root on `test/module9-power-automate-coverage`:

```bash
npm install
npx vitest run src/lib/workflow/power-automate.test.ts
npm test
npx tsc --noEmit
npm run build
```

Capture the terminal output or CI run URL after each command. If a test fails, compare the assertion with the F7 requirements and implementation before changing the expected result. Do not weaken assertions merely to make the suite green.

## 7. Risks and limitations

- These are unit tests with mocked HTTP responses; they do not prove that a real Power Automate flow is configured, reachable, or correctly deployed.
- The HMAC test validates local signature generation, not the receiving flow's signature verification configuration.
- CI results are not yet available for this branch.
- No live external request was sent.
- No production configuration, database schema, migration, or secret was changed.

## 8. Traceability

- Feature: [F7 — Power Automate Workflow Initialization](https://github.com/jjoiles/Financial_Management_System_Group3/issues/7)
- Test-related backlog: [F7.4 — Verify Workflow Initialization](https://github.com/jjoiles/Financial_Management_System_Group3/issues/268)
- Failure/retry test scope: [F7.4.3 — Test flow failure and idempotent retries](https://github.com/jjoiles/Financial_Management_System_Group3/issues/310)
- New test-focused PR: to be linked after creation.

## 9. Acceptance summary

The PR adds dedicated, deterministic unit tests for previously untested Power Automate helper behavior. It is ready for local execution and peer review. The Module 9 deliverable should be considered fully verified only after the targeted tests, full test suite, TypeScript check, and production build pass in the project environment or CI.
