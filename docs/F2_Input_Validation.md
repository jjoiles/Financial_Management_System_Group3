# F2: Input Validation

## Overview

F2 implements client-side input validation for the financial request submission form in the FinReq system. The goal is to prevent invalid or incomplete requests from being submitted by catching errors early and giving the user clear, actionable feedback before anything hits the database.

All validation is powered by a **Zod schema** defined in `src/routes/submit.tsx` that runs on form submission. The schema enforces required fields, data types, value ranges, domain-specific rules (like the Howard email requirement), and conditional requirements that change based on the selected funding source.

---

## What We Built

### 1. Zod Validation Schema

A single `requestSchema` object (defined at the top of `submit.tsx`) validates all form data before it reaches Supabase. This schema handles:

- **Type checking** — emails must be valid email format, amounts must be numbers, dates must be date strings
- **Domain enforcement** — the requester email must end with `@howard.edu` (Howard University only)
- **Required field enforcement** — department, funding source, amount, needed-by date, and business justification are all mandatory
- **Value constraints** — amounts must be positive and under $9,999,999; department names must be 2–80 characters; descriptions max 10,000 characters
- **Date logic** — the needed-by date must be today or in the future (no past dates)
- **Conditional requirements** — extra fields become mandatory depending on the funding source (see below)
- **Grant number soft validation** — when required, must be at least 3 characters (accepts any format since grant numbers vary by agency: NIH, NSF, DOE, etc.)
- **PI auto-prepend** — the Principal Investigator field automatically prepends "Dr." if the user doesn't include it (e.g., typing "Sarah Chen" saves as "Dr. Sarah Chen")

### 2. Conditional Validation (Funding Source Logic)

The form uses Zod's `.superRefine()` to enforce different rules depending on which funding source the user selects:

| Funding Source | Extra Required Fields | Routed To |
|---|---|---|
| **Department** | None | Department Budget Reviewer |
| **Research (R)** | Grant Number, Principal Investigator | Research Administration |
| **University (U)** | University Program | Provost Finance Office |

When the user selects "Research", the Grant Number and PI fields appear in the UI and become required. If they submit without filling them in, they get specific error messages like *"Grant number is required for research funding."* The same pattern applies to "University" funding requiring a program name.

### 3. Error Display

When validation fails on submit:

- Each field with an error gets a **red border** (via `border-destructive`)
- An **error message** appears directly below the invalid field with an alert icon and a human-readable explanation
- The form **does not submit** — the user stays on the page with all their data preserved
- When the user fixes a field and resubmits, only remaining errors are shown (previous errors clear)

### 4. Howard University Email Enforcement

The requester email field enforces two layers of validation:
1. Must be a **syntactically valid email** — checked by `z.string().email()`
2. Must end with **`@howard.edu`** — checked by `.refine(email => email.endsWith("@howard.edu"))`

If the user enters a non-Howard email like `john@gmail.com`, they see: *"Must be a Howard University email (@howard.edu)."*

The placeholder text in the form reads `name@howard.edu` to guide users, and the sidebar validation rules panel explicitly states this requirement.

---

## Files Changed

### `src/routes/submit.tsx`
- **Zod schema**: Defines all validation rules including the `@howard.edu` email refinement, grant number soft validation (min 3 chars), PI auto-prepend "Dr.", and conditional `superRefine` logic for funding-source-dependent fields
- **Error handling**: `handleSubmit` runs `requestSchema.safeParse()`, converts Zod issues to a field→message map, and sets them in React state
- **Field rendering**: Each `<Input>` component receives an `error` prop that controls the red border and error message display
- **Sidebar**: "Validation rules" panel lists the rules in plain language for the user
- **Placeholder**: Updated to `name@howard.edu`

### `src/routes/login.tsx`
- **Default email**: Updated the pre-filled demo email to `faculty@howard.edu` for consistency

---

## Complete Validation Rules Reference

| Field | Type | Validation Rules | Required When |
|---|---|---|---|
| `requesterEmail` | string | Valid email format, must end with `@howard.edu` | Always |
| `department` | string | Trimmed, min 2 chars, max 80 chars | Always |
| `fundingSource` | enum | Must be `department`, `research`, or `university` | Always |
| `amount` | number | Coerced from string, must be positive, max 9,999,999 | Always |
| `neededBy` | date string | Must be today or a future date | Always |
| `priority` | enum | Must be `low`, `medium`, or `high` (defaults to `medium`) | Always |
| `description` | string | Trimmed, min 1 char, max 10,000 chars | Always |
| `grantNumber` | string | Trimmed, min 3 chars (soft validation — any format accepted) | Funding source = `research` |
| `principalInvestigator` | string | Trimmed, auto-prepends "Dr." if missing | Funding source = `research` |
| `universityProgram` | string | Trimmed | Funding source = `university` |

---

## How It Works (Technical Flow)

```
User fills out form → clicks "Submit and trigger workflow"
        ↓
handleSubmit() runs → extracts FormData → calls requestSchema.safeParse()
        ↓
    ┌─ Validation PASSES → errors cleared → request inserted into Supabase
    │                       → attachments uploaded → workflow event created
    │                       → success screen shown with request ID + routing
    │
    └─ Validation FAILS  → Zod issues mapped to { fieldName: errorMessage }
                          → setErrors() updates React state
                          → each <Input> re-renders with red border + message
                          → form stays open, no data lost
```

---

## Database-Level Validation (Defense in Depth)

The client-side Zod schema is the first line of defense, but the database schema in `supabase/migrations/20260428002922_0ba291ef-6600-4926-9100-0a908f77852c.sql` also enforces constraints:

- `amount NUMERIC(12,2) NOT NULL` — amount cannot be null, enforced at DB level
- `funding_source` uses a Postgres enum (`department | research | university`) — invalid values rejected
- `priority` uses a Postgres enum (`low | medium | high`)
- `status` uses a Postgres enum — defaults to `submitted`
- `request_number TEXT NOT NULL UNIQUE` — prevents duplicate submissions
- Row Level Security (RLS) policies ensure users can only insert requests for themselves

This means even if client validation were bypassed, the database would reject malformed data.
