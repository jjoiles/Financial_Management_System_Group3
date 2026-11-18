# F21.1: Role-Based Access Control (RBAC) — Role & Permission Matrix

**Owner:** Ibrahim Osman (`Iosman172`)  
**Issues:** `#67` (`F21.1`), `#88` (`F21.1.1`), `#89` (`F21.1.2`), `#90` (`F21.1.3`)

---

## 1. Identified System Roles (`F21.1.1` / `#88`)

The Financial Request Management System defines four canonical roles in `public.app_role` (`public.user_roles` table) and `src/lib/rbac.ts`:

| System Role (`public.app_role`) | Portal Mapping (`UserRole`) | Description & Scope |
| :--- | :--- | :--- |
| **`requester`** | `requester` | Faculty and staff who submit financial requests, upload supporting attachments, and track their own submissions. |
| **`reviewer`** | `admin` | Department Chairs, Budget Reviewers, and Research Administration officers who review, approve, reject, or return assigned requests. |
| **`leadership`** | `leadership` | Deans, Provost Finance Office, and Executive leadership who oversee SLA compliance, cross-department analytics, and high-value approvals. |
| **`admin`** | `admin` | System administrators who hold full reviewer/analytics capabilities and can manage controlled role assignments in `public.user_roles`. |

---

## 2. Role & Permission Matrix (`F21.1.2` / `#89`)

| Resource / Action | Permission Key (`RbacPermission`) | `requester` | `reviewer` | `leadership` | `admin` | No Role / Unauthenticated |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| Create financial request | `requests:create` | Allowed | Allowed | Allowed | Allowed | **Denied** |
| Read own financial requests | `requests:read_own` | Allowed | Allowed | Allowed | Allowed | **Denied** |
| Read all department / system requests | `requests:read_all` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Update own pending request | `requests:update_own_pending` | Allowed | Allowed | **Denied** | Allowed | **Denied** |
| Record approval / rejection / return decision | `requests:review_decision` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Upload attachment to own request | `attachments:upload_own` | Allowed | Allowed | Allowed | Allowed | **Denied** |
| Read attachments on own requests | `attachments:read_own` | Allowed | Allowed | Allowed | Allowed | **Denied** |
| Read attachments across all requests | `attachments:read_all` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Read workflow events on own requests | `workflow_events:read_own` | Allowed | Allowed | Allowed | Allowed | **Denied** |
| Read workflow events across all requests | `workflow_events:read_all` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Append review / stage decision event | `workflow_events:append_decision` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| View Analytics dashboard (`/analytics`) | `analytics:view` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Export request / analytics CSV | `analytics:export_csv` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| View SLA Tracking dashboard (`/sla`) | `sla:view_dashboard` | **Denied** | Allowed | Allowed | Allowed | **Denied** |
| Assign or modify user roles (`user_roles`) | `roles:assign` | **Denied** | **Denied** | **Denied** | Allowed | **Denied** |

---

## 3. Behavior When a User Has No Recognized Role (`F21.1.3` / `#90`)

1. **Unauthenticated Visitor (`session === null` / `userId === null`):**
   - `resolveUserRoles(..., { isAuthenticated: false })` returns `recognizedRoles: []`, `effectivePrimaryRole: null`, and `reason: "UNAUTHENTICATED"`.
   - `hasPermission([], permission)` evaluates to `false` for every permission.
   - Database RLS policies (`auth.uid() IS NOT NULL`) and `REVOKE EXECUTE ON FUNCTION public.has_role, public.is_admin_or_reviewer FROM PUBLIC, anon` block all anonymous database and storage operations.
2. **Authenticated User With Empty or Unrecognized Role Rows:**
   - Any unrecognized role string (e.g., `"superuser"`, `"guest"`, `""`) is discarded by `isSystemRole()`.
   - When `allowLeastPrivilegeFallback: false` (strict authorization check), `resolveUserRoles()` returns `recognizedRoles: []`, `effectivePrimaryRole: null`, and `reason: "NO_RECOGNIZED_ROLE"`, denying all permissions.
   - When `allowLeastPrivilegeFallback: true` (portal session hydration when `user_roles` has not yet been seeded), the user is restricted to least-privilege `["requester"]` (`fallbackApplied: true`), which permits only `own`-scoped operations (`auth.uid() = user_id`) and denies all reviewer, leadership, analytics, SLA, and role-management actions.
