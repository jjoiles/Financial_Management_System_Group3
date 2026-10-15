# F6: Automated Record Linking

## Overview

F6 makes the database connect related records on its own, so nothing depends on the app wiring IDs together correctly.

1. **User links.** Every `user_id` column now has a foreign key to `auth.users`, fixing the missing-FK item in DEBT_AND_RISK.
2. **Requester profile link.** Each request points to the requester's profile, set automatically.
3. **Related-request links.** When a request is saved, the database finds related requests (same grant, same program, possible duplicate) and links them.
4. **Attachment counts.** Request lists show the real number of linked attachments instead of a hard-coded `0`.

---

## What We Built

### 1. Foreign keys to `auth.users`

| Column | On user delete | Why |
|---|---|---|
| `profiles.user_id` | CASCADE | Profile belongs to the account |
| `user_roles.user_id` | CASCADE | Roles belong to the account |
| `financial_requests.user_id` | RESTRICT | Financial history must not be erased by deleting a user |
| `request_attachments.user_id` | RESTRICT | Same as requests |
| `workflow_events.actor_user_id` | SET NULL | Keep the log, drop only the actor |

DEBT_AND_RISK suggested CASCADE everywhere. F6 uses RESTRICT on financial records because deleting a user would otherwise silently delete their requests and audit trail. To remove a user who has requests, deactivate them instead, or move their requests first.

All keys are `NOT VALID`, so existing orphaned prototype rows do not block the migration. New rows are checked.

### 2. `requester_profile_id`

New column on `financial_requests`, filled by trigger:
- On insert, set from `profiles` where `user_id` matches. A client-sent value is overwritten, so it cannot be spoofed.
- When a profile is created later, the user's earlier requests are linked to it.
- Existing requests are backfilled by the migration.

### 3. `request_links` table

| Column | Meaning |
|---|---|
| `request_id` | the request |
| `linked_request_id` | the related request |
| `link_type` | `same_grant`, `same_program`, or `possible_duplicate` |
| `reason` | readable explanation |

**Linking rules** (trigger `f6_link_related_requests`, after insert, and after update of grant, program, amount, department, or funding source):

| Link type | Rule |
|---|---|
| `same_grant` | Same grant number, ignoring case |
| `same_program` | Same university program, ignoring case |
| `possible_duplicate` | Same requester, department, funding source, and amount, within 7 days, not rejected |

Links are stored in both directions, never point to themselves, and are not duplicated if the trigger runs again. Each new link also writes a `record_linked` event to `workflow_events` (F5).

**Security:**
- A user only sees a link when they can see **both** requests. A requester cannot learn that someone else's request exists on the same grant.
- Only the database creates links. Reviewers and admins can delete one (for example, a false duplicate).

### 4. Front end

- `src/lib/links-data.ts` adds `useRequestLinks()`.
- The request detail dialog shows a **Linked Records** section (duplicates highlighted) and an **Attachments** count.
- `useFinancialRequests()` now loads `request_attachments(count)` so lists show real counts. Prototype rows fall back to `metadata.attachmentCount`.

---

## Files Changed

| File | Change |
|---|---|
| `supabase/migrations/20261015140000_f6_automated_record_linking.sql` | New. FKs, profile link, `request_links`, triggers, RLS |
| `src/lib/links-data.ts` | New. `useRequestLinks()` |
| `src/lib/requests-data.ts` | Real attachment counts |
| `src/components/RequestDetailDialog.tsx` | Linked Records and Attachments |

---

## How to Test

1. Apply the migration.
2. Submit two Research requests with grant `NSF-2041` and `nsf-2041`. Open either one: Linked Records shows **Same grant**.
3. Submit the same department request twice (same amount and department). Both show **Possible duplicate**.
4. As a different requester, open your own request on the same grant: the other user's request is not listed.
5. In the SQL editor, try deleting an `auth.users` row that has requests. It fails with `financial_requests_user_id_fkey`.
6. Submit with 2 attachments. **My Requests** shows 2.

---

## Notes for the Team

- After this migration, regenerate `src/integrations/supabase/types.ts` (Lovable does this on apply). `links-data.ts` uses an untyped client until then.
- **Blocking issue outside F6:** the April migration revokes `EXECUTE` on `is_admin_or_reviewer()` from `authenticated`, so every RLS policy that calls it (including existing ones on `financial_requests`) fails with *permission denied for function*. This is likely why submissions fall back to prototype mode. It belongs to #106/#107. F6's policies work once that grant is restored.
