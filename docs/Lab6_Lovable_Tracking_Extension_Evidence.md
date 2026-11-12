# Lab 6 — Lovable.dev feature extension: My Requests tracking

**Project:** Financial Request Management System (UniFlow Finance)  
**Lovable project:** https://lovable.dev/projects/b71cc96c-624e-4800-b9af-abda0b91a952  
**Feature:** Search, status filters, counts, prototype transparency and reliable local request display on `/tracking`.

## Important integration note
Lovable was connected to `jjoiles/Financial_Management_System_Group3` on `main` and synced its generated feature code **directly to main before this documentation PR was opened**. This PR therefore adds the **reviewable Lab 6 evidence/documentation**, not the original implementation diff. Do not represent this PR as the original code-integration PR. Team review and merge of this documentation PR are still required.

## Before / After

| Area | Before | After |
| --- | --- | --- |
| Search | No request search | Case-insensitive title/request-number search and clear control |
| Filtering | Pending and final-status groups only | All, Submitted, Under Review, Approved, Rejected, Completed chips with counts |
| Result feedback | No matching count or filtered empty state | Matching/total count, no-match message and clear-filters action |
| Prototype clarity | Generic Prototype badge | `Prototype · local only` with explanatory tooltip and local-only count |
| Empty state | No search/filter controls when there were zero requests | Controls remain visible with zero counts |
| Prototype data loading | Missing `updated_at` could throw; backend failure hid local records | `updated_at` fallback, per-row mapping isolation, separate backend failure handling |
| Request visibility | Prototype rows could be displayed for a different signed-in user | Tracking page filters prototype rows to current user ID |

## Lovable generation and human review
Initial Lovable prompt scoped work to `/tracking`, reusable components, no new mock data, and preservation of workflow tracking and request details. Lovable generated `src/components/tracking/RequestSearchBar.tsx`, `StatusFilterChips.tsx`, `RequestCountSummary.tsx`, and modified `src/routes/tracking.tsx`. Lovable also reported a package security update and a related `src/router.tsx` adjustment despite the instruction not to change dependencies; these must be reviewed independently and are **not** represented as necessary for this feature.

A follow-up Lovable prompt addressed a real bug observed during human walkthrough: a request was confirmed in prototype mode but did not appear under My Requests. Lovable updated `src/lib/requests-data.ts` and `src/routes/tracking.tsx` to fix missing dates, isolate backend errors and filter by account. The user subsequently observed a new local prototype request displayed successfully.

## Verification evidence (November 12, 2026)
- GitHub inspection confirms the generated tracking components and updated `requests-data.ts` and `tracking.tsx` exist on `main`.
- Lovable reported a green build and **61 existing tests passing**; these results have **not** been independently reproduced in a local clone.
- Human screenshot: My Requests shows one locally saved Submitted request, correct All (1)/Submitted (1) counts, workflow tracker, and local-only badge.
- Human screenshot: searching `a field trip` shows `1 of 1 request match` and the matching request.
- Not independently evidenced: no-match search, Submitted-chip interaction, cross-account privacy, complete automated regression suite, backend persistence.
- **Backend limitation:** request was stored in browser prototype mode; no claim of Supabase persistence or actual approval workflow.

## Files and architecture
- `src/routes/tracking.tsx`: page-level search/filter state, visibility, empty states, user filtering.
- `src/components/tracking/RequestSearchBar.tsx`: controlled reusable input.
- `src/components/tracking/StatusFilterChips.tsx`: controlled status selection and counts.
- `src/components/tracking/RequestCountSummary.tsx`: matching and local-only counts.
- `src/lib/requests-data.ts`: resilient local/backend aggregation and date fallback.

The tracking feature preserves the existing request card, `WorkflowTracker`, `RequestDetailDialog`, and `/submit` navigation. Review any Lovable package/lockfile changes separately.

## Known limitations and follow-up
- Prototype records are browser-local, not shared or durable across devices.
- Earlier prototype submissions may lack account identity; they may remain hidden under the stricter filter.
- This documentation PR does not recreate the original implementation diff. For a strict Lab 6 code PR requirement, the team should capture/review the actual feature commit history or create a feature branch from before the Lovable sync and open a separate code PR, without rewriting `main`.
- Lab 6 due date was November 5; implementation and tests shown here were performed November 12 and are not backdated.
