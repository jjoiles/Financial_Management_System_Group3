# F23 — One-Click Export & Distribution

## Before / after

Before: `/requests` supported F12 search, status, funding, and sorting, but offered no export action. An existing seven-column CSV serializer and spreadsheet-formula protection were available; its existing contract is unchanged.

After: **Export CSV** downloads the displayed request rows, respecting every active F12 control. Pending rows appear first, then Submitted & Decided rows, exactly as on the page; the selected sort order is preserved within both sections. The CSV includes request ID, title, requester, department, numeric amount, funding source, status, full creation timestamp where available, and a storage label distinguishing backend from locally saved prototype records.

Distribution is explicit and manual: download the file, then share it through an approved channel with authorized recipients. Feedback states **Download started** and **Nothing was sent**. No email, public link, network delivery, or simulated distribution is performed.

## Access and failure behavior

- The action consumes only the rows already loaded through existing RLS and displayed on `/requests`; it does not fetch an additional dataset.
- Existing authentication, MFA gating, role handling, RLS, and ownership filtering remain unchanged.
- Signed-out or incomplete verification, loading, denied access, unavailable backend reads, and zero matching results disable export with a specific reason.
- A denied read blocks exports even if the existing list still displays owned local prototype rows.
- The export service also rejects any foreign-owned prototype row and validates numeric/text CSV values.
- CSV quoting handles commas, quotes, newlines, Unicode, and CRLF record separators. Existing formula-injection protection is reused. A UTF-8 BOM is included in the downloaded file for spreadsheet compatibility.
- Delivery exceptions are shown as errors. Success wording does not claim that the browser has saved the file or that recipients received it.

## Exact changed files

| File | Change |
| --- | --- |
| `src/routes/requests.tsx` | Adds the export action, passing the exact displayed section-ordered results and read state. |
| `src/components/RequestExportAction.tsx` | Reusable styled export control, authentication/read guards, download initiation and manual-sharing/error feedback. |
| `src/lib/csv-export.ts` | Adds an allowlisted request-list serializer while preserving the original seven-column serializer. |
| `src/lib/request-export.ts` | Pure export eligibility and preparation logic; preserves supplied order and rejects foreign local rows. |
| `src/lib/request-export.test.ts` | 16 tests for request CSV fields, escaping, filter/sort/section consistency, empty results, denied reads, ownership, and malformed values. |
| `src/lib/download-file.ts` | Synchronous Blob download helper with delayed object-URL cleanup. |
| `src/lib/download-file.test.ts` | Two tests for download initiation, filename, delayed cleanup, and failed delivery cleanup. |
| `AGENTS.md` | Records the displayed-row-only, guarded, manual-distribution export rule. |
| `roadmap.md` | Tracks F23 scope and completed verification. |
| `docs/F23_Verification_Report.md` | This implementation and verification report. |

## Actual verification

- Targeted tests: `bunx vitest run src/lib/csv-export.test.ts src/lib/request-export.test.ts src/lib/download-file.test.ts src/lib/request-list.test.ts` — **70/70 passed**, four files.
- Full tests: `bunx vitest run` — **179/179 passed**, 12 files.
- TypeScript and production build: platform automatic checks reported **build OK** at `2026-11-18T05:41:44Z`. No separate manual build was run, per platform workflow.
- Browser used the existing signed-in Requester session; no new account or elevated role was created.
- Submitted two genuine requests through the form while intercepting backend writes as unavailable, invoking the existing local-only prototype fallback. No backend request records were created. Amounts were **123.45** and **987.65**.
- Navigated to `/requests`, searched **F23 verification**, selected **Submitted**, **Department**, and **Amount High to Low**.
- Clicked Export CSV inside Playwright's download listener and saved/read the actual file. The file was **632 bytes**, with **two rows**, request IDs matching the visible table order, amounts **987.65 then 123.45**, and **Prototype - local only** labels.
- No page errors or failed network requests were caused by the download click.
- A zero-match search disabled export with empty-result feedback.
- A controlled backend `403 / 42501` response disabled export even though the two owned local requests remained visible. No database permissions or account identities were changed.
- Desktop and 390px mobile screens were inspected; no horizontal page overflow was observed.

## Limitations and unchanged areas

- Secure direct email delivery, recipient permissions, expiring shared links, distribution logs, and revocation are not implemented. Downloads leave application access controls; recipients must be chosen manually and securely.
- The current Requester session initially returned no backend requests. The populated end-to-end check used real local prototype submissions in an isolated browser, not backend-persisted rows. Elevated reviewer/admin datasets were not exercised.
- Safari/iOS and large exports were not verified. Downloads initiate synchronously to retain browser user activation, but a browser can silently block a download or a user can cancel it; feedback only confirms initiation.
- The existing optional F16 approval-stage table remains absent on this hosted backend. It does not block list export, and no unrelated workflow repair was attempted.
- No dependencies, package/lock files, schemas, migrations, authentication code, role assignments, submission logic, request-detail code, tracking page, shared styles, or F12 utilities were changed.
- Work remains on `feature/f23-export-distribution`; no merge or GitHub issue-state update was performed.