# Issue #128 — [S10][F2][F21] End-to-End Verification and Sprint Demo

Branch: `test/128-end-to-end-verification` (based on `d32bbf2`). Verification/documentation only — no application, auth, schema, policy, or dependency changes. Nothing merged.

## Test environment
- Deployment URL: https://acad-request-hub.lovable.app (preview build tested at sandbox localhost against the same hosted backend; preview and published share one backend instance).
- Session: existing injected Requester session only. No reviewer/admin credentials available.
- Date: 2026-11-18 (UTC).

## Evidence types
- **SRC** = source inspection, **AUTO** = automated tests, **MANUAL** = browser run (sandbox preview, not the published URL), **DB** = read-only database query.

## Test steps and results
| # | Check | Expected | Actual | Evidence | Result |
|---|---|---|---|---|---|
| 1 | Submission workflow inspected | Insert to backend, no local fallback | `src/services/request-submission.ts:267-269` and `src/lib/requests/submission-service.ts:140-142` still call `savePrototypeRequest`/`savePrototypeAttachments` (localStorage) when the backend insert fails | SRC | **FAIL** (Issue #127 not done) |
| 2 | Requester can submit on deployed app | Request saved | Not re-run on the published URL in this task. A real backend row exists from earlier sprint verification (F11) | DB | **NOT VERIFIED** on published URL |
| 3 | Submitted request persists in backend | Row in `financial_requests` | 1 row: `FR-2026-HWJCR8`, status `submitted`, created 2026-11-18 06:12:39 UTC, 0 attachments; 1 `workflow_events` row | DB | **PASS** (single record) |
| 4 | Reviewer sees the same request | Reviewer list shows `FR-2026-HWJCR8` | `user_roles` has **0 rows** — no reviewer/admin account exists; no reviewer session | DB | **BLOCKED** (Issue #71) |
| 5 | Requester sees own request | Visible on My Requests | `FR-2026-HWJCR8` visible on /tracking | MANUAL | PASS |
| 6 | No request data in localStorage | Only auth/session keys | After loading /tracking, only the auth session key was present (no `PROTOTYPE_*` keys) | MANUAL | PASS for this session state — but code path in #1 can still write request data when the backend fails, so the criterion is **not guaranteed** |
| 7 | Automated tests | All pass | `bunx vitest run`: 13 files, **195/195 passed** | AUTO | PASS |
| 8 | TypeScript / build | Green | Platform harness build log: no errors | AUTO | PASS |

## Screenshot evidence checklist (still needed for demo)
- [ ] Published-URL submission form + confirmation number (requester)
- [ ] Database row for that submission (redacted)
- [ ] Reviewer dashboard showing the same request — blocked, needs reviewer account
- [ ] DevTools → Application → Local Storage showing only auth keys
- [x] Sandbox capture of My Requests listing `FR-2026-HWJCR8` (not committed; regenerate on demo)

## Dependency status
- **#127 (remove localStorage fallback):** NOT complete — fallback code present (see #1).
- **#71 (RBAC verification):** NOT complete/unverifiable — no role assignments exist.

## Final status
**NOT MET.** Persistence is evidenced for one record and requester visibility passes, but reviewer visibility is BLOCKED and the localStorage criterion FAILS by source inspection until #127 lands. To unblock: merge #127, assign a reviewer role to a test account (#71), then re-run steps 2, 4, 6 on the published URL.
