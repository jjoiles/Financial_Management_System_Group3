import type { UserRole } from "./mock-data";

/**
 * F21: Role-Based Access Control (RBAC) — F21.1: Define Roles & Permissions
 *
 * Centralizes system role definitions (F21.1.1), the formal permission matrix
 * across financial requests, attachments, workflow events, storage files, and
 * routes (F21.1.2), and no-role / unrecognised-role fallback behavior (F21.1.3).
 */

/** F21.1.1: Canonical database roles stored in `public.user_roles`. */
export const SYSTEM_ROLES = ["requester", "reviewer", "leadership", "admin"] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/**
 * F21.1.1: UI-level roles used across portal views (`reviewer` maps to `admin`
 * queue capabilities in the UI while preserving distinct database roles).
 */
export const PORTAL_ROLES = ["requester", "admin", "leadership"] as const;

/** F21.1.2: Discrete actions governed by the RBAC permission matrix. */
export const RBAC_PERMISSIONS = [
  "requests:create",
  "requests:read_own",
  "requests:read_all",
  "requests:update_own_pending",
  "requests:review_decision",
  "attachments:upload_own",
  "attachments:read_own",
  "attachments:read_all",
  "workflow_events:read_own",
  "workflow_events:read_all",
  "workflow_events:append_decision",
  "analytics:view",
  "analytics:export_csv",
  "sla:view_dashboard",
  "roles:assign",
] as const;

export type RbacPermission = (typeof RBAC_PERMISSIONS)[number];

/** F21.1.2: Protected application routes and their required permissions. */
export const ROUTE_REQUIRED_PERMISSIONS: Record<string, RbacPermission | null> = {
  "/": "requests:read_own",
  "/submit": "requests:create",
  "/requests": "requests:read_own",
  "/tracking": "requests:read_own",
  "/analytics": "analytics:view",
  "/sla": "sla:view_dashboard",
};

/**
 * F21.1.2: Formal permission matrix mapping each recognized system role to its
 * granted permissions.
 */
export const ROLE_PERMISSION_MATRIX: Readonly<Record<SystemRole, readonly RbacPermission[]>> = {
  requester: [
    "requests:create",
    "requests:read_own",
    "requests:update_own_pending",
    "attachments:upload_own",
    "attachments:read_own",
    "workflow_events:read_own",
  ],
  reviewer: [
    "requests:create",
    "requests:read_own",
    "requests:read_all",
    "requests:update_own_pending",
    "requests:review_decision",
    "attachments:upload_own",
    "attachments:read_own",
    "attachments:read_all",
    "workflow_events:read_own",
    "workflow_events:read_all",
    "workflow_events:append_decision",
    "analytics:view",
    "analytics:export_csv",
    "sla:view_dashboard",
  ],
  leadership: [
    "requests:create",
    "requests:read_own",
    "requests:read_all",
    "requests:review_decision",
    "attachments:upload_own",
    "attachments:read_own",
    "attachments:read_all",
    "workflow_events:read_own",
    "workflow_events:read_all",
    "workflow_events:append_decision",
    "analytics:view",
    "analytics:export_csv",
    "sla:view_dashboard",
  ],
  admin: [
    "requests:create",
    "requests:read_own",
    "requests:read_all",
    "requests:update_own_pending",
    "requests:review_decision",
    "attachments:upload_own",
    "attachments:read_own",
    "attachments:read_all",
    "workflow_events:read_own",
    "workflow_events:read_all",
    "workflow_events:append_decision",
    "analytics:view",
    "analytics:export_csv",
    "sla:view_dashboard",
    "roles:assign",
  ],
} as const;

const SYSTEM_ROLE_SET = new Set<string>(SYSTEM_ROLES);

/** F21.1.1: Type guard checking whether a raw string is a recognized SystemRole. */
export function isSystemRole(value: unknown): value is SystemRole {
  return typeof value === "string" && SYSTEM_ROLE_SET.has(value.trim().toLowerCase());
}

/**
 * F21.1.1: Maps a recognized database `SystemRole` to the portal `UserRole`,
 * returning `null` for unrecognized values.
 */
export function mapDatabaseRoleToPortalRole(role: unknown): UserRole | null {
  if (typeof role !== "string") return null;
  const normalized = role.trim().toLowerCase();
  if (normalized === "admin" || normalized === "reviewer") return "admin";
  if (normalized === "leadership") return "leadership";
  if (normalized === "requester") return "requester";
  return null;
}

export type RoleResolutionResult = {
  recognizedRoles: SystemRole[];
  portalRoles: UserRole[];
  effectivePrimaryRole: SystemRole | null;
  fallbackApplied: boolean;
  reason?: "UNAUTHENTICATED" | "NO_RECOGNIZED_ROLE";
};

/**
 * F21.1.3: Defines exact system behavior when a user has no recognized role
 * or is unauthenticated:
 * - Unauthenticated users (`userId` missing/null) receive zero roles (`[]`) and
 *   `effectivePrimaryRole: null` (all protected operations denied).
 * - Authenticated users whose `user_roles` rows are empty or contain only
 *   unrecognized strings default safely to least-privilege `["requester"]` for
 *   own-request read/submit only (`fallbackApplied: true`), and are denied all
 *   reviewer, leadership, and admin permissions.
 */
export function resolveUserRoles(
  rawRoles: readonly unknown[] | null | undefined,
  options: { isAuthenticated: boolean; allowLeastPrivilegeFallback?: boolean },
): RoleResolutionResult {
  if (!options.isAuthenticated) {
    return {
      recognizedRoles: [],
      portalRoles: [],
      effectivePrimaryRole: null,
      fallbackApplied: false,
      reason: "UNAUTHENTICATED",
    };
  }

  const recognized: SystemRole[] = [];
  const portal: UserRole[] = [];

  for (const raw of rawRoles ?? []) {
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (isSystemRole(normalized) && !recognized.includes(normalized)) {
        recognized.push(normalized);
      }
      const mapped = mapDatabaseRoleToPortalRole(normalized);
      if (mapped && !portal.includes(mapped)) {
        portal.push(mapped);
      }
    }
  }

  if (recognized.length === 0) {
    if (options.allowLeastPrivilegeFallback) {
      return {
        recognizedRoles: ["requester"],
        portalRoles: ["requester"],
        effectivePrimaryRole: "requester",
        fallbackApplied: true,
        reason: "NO_RECOGNIZED_ROLE",
      };
    }
    return {
      recognizedRoles: [],
      portalRoles: [],
      effectivePrimaryRole: null,
      fallbackApplied: true,
      reason: "NO_RECOGNIZED_ROLE",
    };
  }

  // Precedence order for primary role: admin > leadership > reviewer > requester
  const precedence: SystemRole[] = ["admin", "leadership", "reviewer", "requester"];
  const effectivePrimaryRole =
    precedence.find((candidate) => recognized.includes(candidate)) ?? recognized[0]!;

  return {
    recognizedRoles: recognized,
    portalRoles: portal,
    effectivePrimaryRole,
    fallbackApplied: false,
  };
}

/**
 * F21.1.2 & F21.1.3: Checks whether a user with the given roles is granted a
 * specific permission from `ROLE_PERMISSION_MATRIX`. Users with no recognized
 * roles are denied all permissions (`false`).
 */
export function hasPermission(
  userRoles: readonly unknown[] | null | undefined,
  permission: RbacPermission,
): boolean {
  if (!Array.isArray(userRoles) || userRoles.length === 0) return false;
  for (const candidate of userRoles) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if (!isSystemRole(normalized)) continue;
    if (ROLE_PERMISSION_MATRIX[normalized].includes(permission)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// F21.2: User-Role Management (F21.2.1, F21.2.2, F21.2.3)
// ---------------------------------------------------------------------------

export type UserRoleAssociation = {
  userId: string;
  systemRoles: SystemRole[];
  portalRoles: UserRole[];
  primaryRole: SystemRole;
  fallbackApplied: boolean;
};

/**
 * F21.2.1: Associates an authenticated user ID with their validated system and
 * portal roles. Returns `null` when `userId` is missing or blank.
 */
export function associateUserWithRoles(params: {
  userId: string | null | undefined;
  rawRoles: readonly unknown[] | null | undefined;
}): UserRoleAssociation | null {
  const cleanUserId = typeof params.userId === "string" ? params.userId.trim() : "";
  if (!cleanUserId) return null;

  const resolved = resolveUserRoles(params.rawRoles, {
    isAuthenticated: true,
    allowLeastPrivilegeFallback: true,
  });

  return {
    userId: cleanUserId,
    systemRoles: resolved.recognizedRoles,
    portalRoles: resolved.portalRoles.length > 0 ? resolved.portalRoles : ["requester"],
    primaryRole: resolved.effectivePrimaryRole ?? "requester",
    fallbackApplied: resolved.fallbackApplied,
  };
}

export type RoleRow = { role: string };

/**
 * F21.2.2: Retrieves an authenticated user's roles upon sign-in from the
 * provided role query port (`public.user_roles`), applying least-privilege
 * `requester` fallback if the query fails or returns no recognized roles.
 */
export async function retrieveSignedInUserRoles(
  userId: string | null | undefined,
  fetchRoleRows: (uid: string) => Promise<{ data: readonly RoleRow[] | null; error: unknown }>,
): Promise<UserRoleAssociation | null> {
  const cleanUserId = typeof userId === "string" ? userId.trim() : "";
  if (!cleanUserId) return null;

  try {
    const { data, error } = await fetchRoleRows(cleanUserId);
    if (error || !Array.isArray(data)) {
      return associateUserWithRoles({ userId: cleanUserId, rawRoles: [] });
    }
    return associateUserWithRoles({
      userId: cleanUserId,
      rawRoles: data.map((row) => row.role),
    });
  } catch {
    return associateUserWithRoles({ userId: cleanUserId, rawRoles: [] });
  }
}

export type ControlledRoleChangeRequest = {
  actorUserId: string | null | undefined;
  actorRoles: readonly unknown[] | null | undefined;
  targetUserId: string | null | undefined;
  newRole: unknown;
};

export type ControlledRoleChangeResult =
  | {
      allowed: true;
      actorUserId: string;
      targetUserId: string;
      assignedRole: SystemRole;
    }
  | {
      allowed: false;
      code:
        | "UNAUTHENTICATED_ACTOR"
        | "FORBIDDEN_ROLE_ASSIGNMENT"
        | "INVALID_TARGET_USER"
        | "INVALID_ROLE"
        | "SELF_ADMIN_DEMOTION_BLOCKED";
      message: string;
    };

/**
 * F21.2.3: Validates and authorizes a controlled role assignment or role change.
 * Only authenticated administrators with `roles:assign` may assign roles, target
 * user and new role must be valid, and an admin cannot demote themselves out of
 * admin rights.
 */
export function validateControlledRoleAssignment(
  request: ControlledRoleChangeRequest,
): ControlledRoleChangeResult {
  const actorId = typeof request.actorUserId === "string" ? request.actorUserId.trim() : "";
  if (!actorId) {
    return {
      allowed: false,
      code: "UNAUTHENTICATED_ACTOR",
      message: "You must be signed in to manage user roles.",
    };
  }

  if (!hasPermission(request.actorRoles, "roles:assign")) {
    return {
      allowed: false,
      code: "FORBIDDEN_ROLE_ASSIGNMENT",
      message: "Only system administrators are authorized to assign or change user roles.",
    };
  }

  const targetId = typeof request.targetUserId === "string" ? request.targetUserId.trim() : "";
  if (!targetId) {
    return {
      allowed: false,
      code: "INVALID_TARGET_USER",
      message: "A valid target user ID is required for role assignment.",
    };
  }

  const normalizedRole =
    typeof request.newRole === "string" ? request.newRole.trim().toLowerCase() : "";
  if (!isSystemRole(normalizedRole)) {
    return {
      allowed: false,
      code: "INVALID_ROLE",
      message: `Unrecognized system role "${String(request.newRole)}".`,
    };
  }

  if (actorId === targetId && normalizedRole !== "admin") {
    return {
      allowed: false,
      code: "SELF_ADMIN_DEMOTION_BLOCKED",
      message: "Administrators cannot remove their own admin role.",
    };
  }

  return {
    allowed: true,
    actorUserId: actorId,
    targetUserId: targetId,
    assignedRole: normalizedRole,
  };
}

// ---------------------------------------------------------------------------
// F21.3: Front-End Authorization (F21.3.1, F21.3.2, F21.3.3)
// ---------------------------------------------------------------------------

/**
 * F21.3.1: Checks whether a user with the provided roles is authorized to access
 * a given application route pathname.
 */
export function canAccessRoute(
  userRoles: readonly unknown[] | null | undefined,
  pathname: string,
): boolean {
  const normalizedPath = pathname.trim().replace(/\/+$/, "") || "/";
  if (normalizedPath === "/login") return true;

  const requiredPermission = ROUTE_REQUIRED_PERMISSIONS[normalizedPath];
  if (!requiredPermission) {
    // Unknown protected route requires at least own-request read capability
    return hasPermission(userRoles, "requests:read_own");
  }
  return hasPermission(userRoles, requiredPermission);
}

export type AuthorizedActionState = {
  canCreateRequest: boolean;
  canViewOwnRequests: boolean;
  canViewAllRequests: boolean;
  canReviewRequest: boolean;
  canViewAnalytics: boolean;
  canExportAnalyticsCsv: boolean;
  canViewSlaDashboard: boolean;
  canManageRoles: boolean;
};

/**
 * F21.3.2: Computes front-end action visibility and enabled/disabled flags for
 * the current user's roles so unauthorized buttons and controls are hidden or
 * disabled consistently.
 */
export function getAuthorizedActionState(
  userRoles: readonly unknown[] | null | undefined,
): AuthorizedActionState {
  return {
    canCreateRequest: hasPermission(userRoles, "requests:create"),
    canViewOwnRequests: hasPermission(userRoles, "requests:read_own"),
    canViewAllRequests: hasPermission(userRoles, "requests:read_all"),
    canReviewRequest: hasPermission(userRoles, "requests:review_decision"),
    canViewAnalytics: hasPermission(userRoles, "analytics:view"),
    canExportAnalyticsCsv: hasPermission(userRoles, "analytics:export_csv"),
    canViewSlaDashboard: hasPermission(userRoles, "sla:view_dashboard"),
    canManageRoles: hasPermission(userRoles, "roles:assign"),
  };
}

export type UnauthorizedAccessResponse = {
  status: 401 | 403;
  code: "AUTHENTICATION_REQUIRED" | "INSUFFICIENT_ROLE_PERMISSIONS";
  title: string;
  message: string;
  requiredPermission: RbacPermission | null;
  redirectTo: "/login" | "/";
};

/**
 * F21.3.3: Builds an explicit, user-facing unauthorized-access response when a
 * user without sufficient permissions attempts to view a restricted page or
 * invoke a restricted UI action.
 */
export function buildUnauthorizedAccessResponse(params: {
  isAuthenticated: boolean;
  userRoles: readonly unknown[] | null | undefined;
  targetPath?: string;
  requiredPermission?: RbacPermission | null;
}): UnauthorizedAccessResponse {
  const normalizedPath = params.targetPath?.trim().replace(/\/+$/, "") || "/";
  const required =
    params.requiredPermission ?? ROUTE_REQUIRED_PERMISSIONS[normalizedPath] ?? null;

  if (!params.isAuthenticated) {
    return {
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      title: "Sign-In Required",
      message: "Please sign in with your Howard University account to access this page.",
      requiredPermission: required,
      redirectTo: "/login",
    };
  }

  return {
    status: 403,
    code: "INSUFFICIENT_ROLE_PERMISSIONS",
    title: "Access Restricted",
    message:
      "Your current role does not have permission to view this page or perform this action. Contact an administrator if you require reviewer or leadership access.",
    requiredPermission: required,
    redirectTo: "/",
  };
}

// ---------------------------------------------------------------------------
// F21.4: Back-End / Data Authorization (F21.4.1, F21.4.2, F21.4.3)
// ---------------------------------------------------------------------------

export type BackendAuthorizationRequest = {
  authenticatedUid: string | null | undefined;
  claimedActorUid?: string | null | undefined;
  userRoles: readonly unknown[] | null | undefined;
  permission: RbacPermission;
  resourceOwnerUid?: string | null | undefined;
};

export type BackendAuthorizationDecision =
  | {
      authorized: true;
      boundUid: string;
      permission: RbacPermission;
    }
  | {
      authorized: false;
      status: 401 | 403;
      code:
        | "UNAUTHENTICATED"
        | "UID_SPOOFING_DETECTED"
        | "PERMISSION_DENIED"
        | "CROSS_USER_RESOURCE_DENIED";
      message: string;
    };

const OWN_SCOPED_PERMISSIONS: Readonly<Partial<Record<RbacPermission, RbacPermission>>> = {
  "requests:read_own": "requests:read_all",
  "requests:update_own_pending": "requests:review_decision",
  "attachments:upload_own": "attachments:read_all",
  "attachments:read_own": "attachments:read_all",
  "workflow_events:read_own": "workflow_events:read_all",
};

/**
 * F21.4.1 & F21.4.2: Enforces backend/service-level permissions independent of
 * front-end UI guards. Binds identity checks to `authenticatedUid` (equivalent
 * to `auth.uid()`), detects payload/header UID spoofing attempts, and enforces
 * resource-owner scoping.
 */
export function authorizeBackendOperation(
  request: BackendAuthorizationRequest,
): BackendAuthorizationDecision {
  const authUid =
    typeof request.authenticatedUid === "string" ? request.authenticatedUid.trim() : "";
  if (!authUid) {
    return {
      authorized: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Authenticated session (auth.uid()) is required for database operations.",
    };
  }

  // F21.4.2 & F21.5.3: Block any request where the client payload claims a different userId
  if (
    request.claimedActorUid !== undefined &&
    request.claimedActorUid !== null &&
    request.claimedActorUid.trim() !== authUid
  ) {
    return {
      authorized: false,
      status: 403,
      code: "UID_SPOOFING_DETECTED",
      message: "Claimed actor user ID does not match the authenticated session identity.",
    };
  }

  if (!hasPermission(request.userRoles, request.permission)) {
    return {
      authorized: false,
      status: 403,
      code: "PERMISSION_DENIED",
      message: `Role lacks required backend permission "${request.permission}".`,
    };
  }

  // Enforce owner-scoping when a resourceOwnerUid is supplied on an own-scoped operation
  const ownerUid =
    typeof request.resourceOwnerUid === "string" ? request.resourceOwnerUid.trim() : "";
  if (ownerUid && ownerUid !== authUid && request.permission in OWN_SCOPED_PERMISSIONS) {
    const elevatedOverride = OWN_SCOPED_PERMISSIONS[request.permission];
    const hasElevatedOverride =
      elevatedOverride !== undefined && hasPermission(request.userRoles, elevatedOverride);
    if (!hasElevatedOverride) {
      return {
        authorized: false,
        status: 403,
        code: "CROSS_USER_RESOURCE_DENIED",
        message: "Cannot access or modify another user's financial record or attachment.",
      };
    }
  }

  return {
    authorized: true,
    boundUid: authUid,
    permission: request.permission,
  };
}

/**
 * F21.4.3: Restricts access to uploaded files and sensitive financial records.
 * Verifies storage path ownership (`{ownerUid}/{requestId}/{fileName}`) or
 * elevated reviewer/leadership/admin read privileges.
 */
export function authorizeFinancialRecordAndFileAccess(params: {
  authenticatedUid: string | null | undefined;
  userRoles: readonly unknown[] | null | undefined;
  recordOwnerUid: string;
  storagePath?: string;
  mode: "read" | "upload";
}): BackendAuthorizationDecision {
  const authUid =
    typeof params.authenticatedUid === "string" ? params.authenticatedUid.trim() : "";
  if (!authUid) {
    return {
      authorized: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Sign-in is required to access financial records or attachment files.",
    };
  }

  // Verify storage path prefix matches recordOwnerUid and contains no path traversal
  if (params.storagePath) {
    const cleanPath = params.storagePath.trim();
    if (cleanPath.includes("..") || !cleanPath.startsWith(`${params.recordOwnerUid}/`)) {
      return {
        authorized: false,
        status: 403,
        code: "CROSS_USER_RESOURCE_DENIED",
        message: "Storage path does not belong to the authorized financial record owner.",
      };
    }
  }

  if (params.mode === "upload") {
    if (params.recordOwnerUid !== authUid) {
      return {
        authorized: false,
        status: 403,
        code: "CROSS_USER_RESOURCE_DENIED",
        message: "Users may only upload attachments to their own financial requests.",
      };
    }
    return authorizeBackendOperation({
      authenticatedUid: authUid,
      userRoles: params.userRoles,
      permission: "attachments:upload_own",
      resourceOwnerUid: params.recordOwnerUid,
    });
  }

  return authorizeBackendOperation({
    authenticatedUid: authUid,
    userRoles: params.userRoles,
    permission: "attachments:read_own",
    resourceOwnerUid: params.recordOwnerUid,
  });
}



