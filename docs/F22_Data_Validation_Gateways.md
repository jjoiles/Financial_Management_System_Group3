# F22: Data Validation Gateways

## Overview

F22 adds layered validation so a financial request is checked at three points before it is stored. F2 added the client-side Zod form check. F22 builds on it by making sure the same rules hold even if someone skips the form and calls Supabase directly with the publishable key.

| Gateway | Where it runs | What it does |
|---|---|---|
| 1. Form | Browser, `validateSubmission()` | Cleans input and returns field-level errors |
| 2. Payload | Browser, `buildValidatedPayload()` | Builds the database row, clears fields that do not belong to the funding source, re-checks the row shape |
| 3. Database | Postgres trigger + CHECK constraints | Final check that cannot be bypassed from the client |

---

## What We Built

### 1. Shared validation module

The Zod schema moved out of `submit.tsx` into `src/lib/validation/request-schema.ts`, so other features (routing, workflow, tests) can import it. Rules from F2 are unchanged. New rules:

- Text is cleaned before checks: control characters removed, extra spaces collapsed, line endings normalized
- Email is lowercased before the `@howard.edu` check
- Amount can have at most 2 decimal places (the database column is `NUMERIC(12,2)` and would otherwise round silently)
- Max lengths on grant number (64), PI name (120), and program name (120)
- Needed-by must be a real `YYYY-MM-DD` date

### 2. Payload gateway

`buildValidatedPayload()` in `src/lib/validation/gateways.ts` turns validated form input into the `financial_requests` row. It:

- Sets `grant_number` and `principal_investigator` to `null` unless funding is Research
- Sets `university_program` to `null` unless funding is University
- Rounds amount to cents
- Uses the first line of the justification as the title
- Re-validates the row (user ID is a UUID, request number matches `FR-YYYY-XXXXXX`, status is `submitted`, conditional fields present)

### 3. Database gateway

Migration `supabase/migrations/20261015120000_f22_data_validation_gateways.sql` adds:

**Normalization trigger** (`f22_normalize_financial_request`, runs before insert and update):
- Trims text, lowercases email, collapses spaces in department
- Clears conditional fields that do not match the funding source
- Rejects a needed-by date in the past (Eastern time). Only checked when the date is set or changed, so old requests can still move through review.

**CHECK constraints on `financial_requests`:**

| Constraint | Rule |
|---|---|
| `financial_requests_amount_range` | 0 < amount ≤ 9,999,999.99 |
| `financial_requests_amount_precision` | at most 2 decimal places |
| `financial_requests_email_domain` | ends in `@howard.edu` |
| `financial_requests_department_length` | 2 to 80 characters |
| `financial_requests_title_length` | 1 to 120 characters |
| `financial_requests_description_length` | 1 to 10,000 characters |
| `financial_requests_grant_number_length` | 3 to 64 characters when present |
| `financial_requests_research_fields` | Research requires grant number and PI |
| `financial_requests_university_fields` | University requires program |

**CHECK constraints on `request_attachments`:** file name 1 to 255 characters, non-negative size, no `..` in storage paths.

All constraints are added `NOT VALID`, so existing prototype rows do not block the migration. They are still enforced on every new insert and update.

### 4. Database errors shown on the form

Before F22, any database error on insert made the app fall back to prototype mode and save the request in localStorage. A request the database rejected as invalid would look like it succeeded.

Now `mapDatabaseValidationError()` recognizes validation errors (`23514` CHECK violation, `P0001` trigger error, `22P02` bad input) and maps the constraint name back to the form field. The user sees the error on the right field and the request is not saved. Prototype fallback is still used for connection or availability problems.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/validation/request-schema.ts` | New. Shared Zod schema, limits, text cleaning helpers |
| `src/lib/validation/gateways.ts` | New. Gateway functions and database error mapping |
| `src/routes/submit.tsx` | Uses the gateways; stops prototype fallback on validation errors |
| `supabase/migrations/20261015120000_f22_data_validation_gateways.sql` | New. Trigger and constraints |

---

## How to Test

1. Apply the migration in Supabase (SQL editor or `supabase db push`).
2. On `/submit`, try each case and confirm the error appears under the field:
   - Email `test@gmail.com`
   - Amount `10.555`
   - Research funding with no grant number
   - University funding with no program
3. Bypass test: in the Supabase SQL editor, insert a row with `requester_email = 'x@gmail.com'`. It should fail with `financial_requests_email_domain`.
4. Select Research, type a grant number, switch to Department, submit. The saved row should have `grant_number = null`.

---

## Notes for the Team

- If any limit changes, update both `request-schema.ts` and the migration.
- `NOT VALID` skips the check for existing rows only at migration time. **An UPDATE to an old row that breaks a rule is still rejected**, so a reviewer cannot change the status of a legacy prototype row with, say, a gmail address until the row is fixed. Find them with `SELECT id, request_number FROM financial_requests WHERE requester_email NOT LIKE '%@howard.edu';` (and similar per rule).
- To enforce constraints on old rows too, clean them, then run `ALTER TABLE public.financial_requests VALIDATE CONSTRAINT <name>;`
- File type and size rules for uploads are left to F3.
