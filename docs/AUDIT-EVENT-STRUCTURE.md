# F13: Audit Event Structure

## 1. Purpose

The audit log provides a chronological, traceable history of actions
performed on financial requests. It supports accountability,
transparency, and administrative review.

The existing `public.workflow_events` table is the central audit
event store. This feature extends and standardizes its use rather
than creating a second event table.

## 2. Standard Event Structure

Every audit event uses the following fields:

| Field | Type | Purpose |
|---|---|---|
| id | UUID | Unique event identifier |
| request_id | UUID | Financial request associated with the event |
| actor_user_id | UUID, nullable | User responsible for the action |
| event_type | TEXT | Machine-readable event category |
| message | TEXT | Human-readable event description |
| metadata | JSONB | Structured event details |
| created_at | TIMESTAMPTZ | Event creation timestamp |

System-generated events may have a null actor when no authenticated
user initiated the operation. Metadata should identify the source
of the event when available.

## 3. Required Event Categories

| Event type | When it is recorded |
|---|---|
| request_created | A financial request is created |
| request_updated | Tracked request information is modified |
| status_changed | A request changes status |
| routing_changed | A request is assigned to a different reviewer or queue |
| attachment_added | An attachment is added to a request |
| attachment_removed | An attachment is removed from a request |
| approval_approved | A reviewer approves a request or approval stage |
| approval_rejected | A reviewer rejects a request or approval stage |

## 4. Event Metadata

Metadata provides additional structured context without changing
the standard event columns.

Examples include:

- Request number and current status.
- Previous and updated values for tracked fields.
- Previous and new routing destinations.
- Approval stage, reviewer decision, and decision comment.
- Attachment identifier, file name, size, and content type.
- Event source, such as a database trigger or approval procedure.

Sensitive credentials, access tokens, passwords, and file contents
must never be copied into audit metadata.

Long descriptions should be represented as changed indicators
rather than copying their entire contents into the audit log.

## 5. Actor and Timestamp Requirements

- Capture the authenticated user's UUID whenever available.
- Use `auth.uid()` for database operations initiated by an authenticated user.
- Use a null actor only for system operations without an authenticated user.
- Record timestamps using `TIMESTAMPTZ`.
- Use the database-generated timestamp as the authoritative event time.
- Preserve event history rather than rewriting earlier timestamps.

## 6. Audit Event Recording Rules

1. Request creation must generate a creation event.
2. Changes to tracked request fields must generate update events.
3. Status and routing changes must be identifiable as separate events.
4. Attachment creation and removal must be recorded.
5. Approval and rejection decisions must identify the decision and stage.
6. Events must reference the financial request they describe.
7. Events must be retained as historical records.

## 7. Activity History

Events should be displayed chronologically for the associated
financial request.

The activity history should identify:

- What happened.
- Who performed the action, when available.
- When the action occurred.
- The event category.

Only users authorized to view the associated financial request
may view its audit history.

## 8. Implementation References

The existing implementation includes:

- `supabase/migrations/20261015130000_f5_automated_data_logging.sql`
- `supabase/migrations/20261113233242_f16_approval_decisions.sql`
- `src/lib/activity-data.ts`
- `src/components/RequestDetailDialog.tsx`
- `src/integrations/supabase/types.ts`

This specification defines the expected event structure.
Permission enforcement, remaining event coverage, interface
improvements, and automated verification are addressed in
F13 subissues #146 through #149.

## 9. Administrative Change Tracking

The automated request trigger also tracks administrative changes to:

- `user_id`: reassignment of request ownership.
- `request_number`: correction of a request identifier.

For request creation and updates, audit metadata includes an
`actorRoles` snapshot containing the authenticated actor's roles
at the time the event was recorded.

The existing `actor_user_id` remains the authoritative user identifier.
Generated metadata and workflow bookkeeping are excluded from
ordinary field-change logging to avoid noisy or sensitive events.

## 10. Audit Access and Immutability

The `workflow_events` table uses row-level security.

- Authenticated requesters can read activity associated with their own requests.
- Authorized administrators, reviewers, and leadership can read permitted request history.
- Anonymous users cannot read audit events.
- Authenticated application clients cannot directly insert, update, delete, or truncate audit records.
- Trusted database triggers and SECURITY DEFINER procedures remain responsible for generating events.
- Historical audit records cannot be changed through ordinary application client permissions.

The database owner and trusted elevated administrative operations remain
responsible for exceptional database maintenance.

## 11. Activity History Display

The request detail activity timeline displays:

- A readable description of each recorded action.
- The event category.
- The responsible user's profile display name when available.
- The event timestamp.
- A system label for events without an authenticated actor.

Profile names are retrieved through the existing profiles table and
its row-level security policies. When a profile name is not visible
to the current user, the timeline uses a shortened user identifier
rather than exposing additional profile information.

Events remain ordered chronologically.

## 12. Audit Logging Verification

The database integration tests are located at:

- `supabase/tests/f13_audit_logging.test.sql`

They verify:

- Event actor identification and role snapshots.
- Database-generated event timestamps.
- Request creation, status changes, and tracked field changes.
- Authenticated read access and prohibited client write operations.
- Requester isolation from other request histories.
- Reviewer access to permitted request histories.

Run the database tests against the local Supabase stack:

```bash
npx supabase test db
```

The test uses fictional users and requests and rolls back its
fixtures at the end.
