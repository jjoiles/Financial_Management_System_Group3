# F8: Intelligent Branching Routing Logic

## Overview

Before F8, routing was a three-entry lookup: funding source mapped to one reviewer. F8 replaces it with a rules engine that branches on funding source, amount, priority, and due date, and produces a full ordered approval chain with a reason for every step.

The engine is a pure function in `src/lib/routing/engine.ts`. All thresholds and queue names live in `src/lib/routing/rules.ts`.

---

## What We Built

### 1. Routing rules

| Branch | Condition | Result |
|---|---|---|
| Base queue | Department funding | Department Budget Reviewer |
| | Research funding | Research Administration |
| | University funding | Provost Finance Office |
| Amount tier | Department or University, amount ≥ $5,000 | + Dean's Office |
| | Research, amount ≥ $25,000 | + Office of Sponsored Programs |
| | Any funding, amount ≥ $25,000 | + Office of the CFO (`high_value` flag) |
| Urgency | Priority is High | `expedited` flag |
| | Needed within 3 days | `expedited` flag |

When several rules apply, all of their approvers are added, then ordered by `QUEUE_ORDER`: base queue, sponsored programs, dean, CFO. The first step becomes `routed_to`.

**These thresholds are starting defaults, not confirmed university policy.** Change them in `rules.ts` and bump `RULES_VERSION`.

### 2. Routing decision

`routeRequest()` returns:

```ts
{
  primaryQueue: "department_budget",
  primaryLabel: "Department Budget Reviewer",
  approvalChain: [
    { step: 1, queue: "department_budget", label: "Department Budget Reviewer", reason: "..." },
    { step: 2, queue: "dean_office", label: "Dean's Office", reason: "..." }
  ],
  flags: ["multi_level"],
  reasons: ["...", "..."],
  rulesVersion: "2026-10-15.1",
  decidedAt: "2026-10-15T16:00:00.000Z"
}
```

It is saved in `financial_requests.metadata.routing`, so a request keeps the decision made under the rules in force when it was submitted, even if rules change later.

### 3. Helpers for later features

- `getNextApprovalStep(decision, approvedSteps)` returns the next approver, or `null` when the chain is done. F10 (reviewer notifications) and F16 (SLA tracking) can use it.
- `readRoutingDecision(metadata)` reads the stored decision. Returns `null` for requests created before F8.

### 4. UI

- **Submit page sidebar:** live preview of the approval chain as the user fills in funding source, amount, priority, and date
- **Success screen:** shows the chain and flags after submission
- **Request detail dialog:** shows the stored chain with each step's reason

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/routing/rules.ts` | New. Queues, thresholds, ordering |
| `src/lib/routing/engine.ts` | New. `routeRequest()` and helpers |
| `src/routes/submit.tsx` | Uses the engine; live preview; chain on success screen |
| `src/lib/requests-data.ts` | Adds `routing` to `EnrichedRequest` |
| `src/components/RequestDetailDialog.tsx` | Shows the approval chain |

---

## How to Test

On `/submit`, fill the form and watch the sidebar:

| Funding | Amount | Priority | Expected chain |
|---|---|---|---|
| Department | 500 | Medium | Department Budget Reviewer |
| Department | 5,000 | Medium | Department Budget Reviewer → Dean's Office |
| Department | 30,000 | Medium | Department Budget Reviewer → Dean's Office → Office of the CFO, High value |
| Research | 10,000 | Medium | Research Administration |
| Research | 30,000 | Medium | Research Administration → Office of Sponsored Programs → Office of the CFO |
| University | 6,000 | High | Provost Finance Office → Dean's Office, Expedited |

Set Needed-by to 2 days from today with Medium priority: the request should show Expedited.

---

## Notes for the Team

- Routing runs in the browser at submit time. F7 recomputes it on the server so a modified client cannot pick its own route.
- F1 (conditional logic) centralizes form rules; routing rules stay in `src/lib/routing/` so the two do not collide.
