import { describe, expect, it } from "vitest";
import {
  associateUserWithRoles,
  authorizeBackendOperation,
  authorizeFinancialRecordAndFileAccess,
  buildUnauthorizedAccessResponse,
  canAccessRoute,
  getAuthorizedActionState,
  hasPermission,
  isSystemRole,
  mapDatabaseRoleToPortalRole,
  resolveUserRoles,
  retrieveSignedInUserRoles,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
  validateControlledRoleAssignment,
} from "./rbac";

describe("F21.1: Define Roles & Permissions (F21.1.1–F21.1.3)", () => {
  it("identifies all four canonical system roles (F21.1.1)", () => {
    expect(SYSTEM_ROLES).toEqual(["requester", "reviewer", "leadership", "admin"]);
    expect(isSystemRole("requester")).toBe(true);
    expect(isSystemRole("reviewer")).toBe(true);
    expect(isSystemRole("leadership")).toBe(true);
    expect(isSystemRole("admin")).toBe(true);
    expect(isSystemRole("superadmin")).toBe(false);
    expect(isSystemRole(null)).toBe(false);
  });

  it("maps database roles to portal roles accurately (F21.1.1)", () => {
    expect(mapDatabaseRoleToPortalRole("requester")).toBe("requester");
    expect(mapDatabaseRoleToPortalRole("reviewer")).toBe("admin");
    expect(mapDatabaseRoleToPortalRole("admin")).toBe("admin");
    expect(mapDatabaseRoleToPortalRole("leadership")).toBe("leadership");
    expect(mapDatabaseRoleToPortalRole("unknown")).toBeNull();
  });

  it("enforces the permission matrix for each role (F21.1.2)", () => {
    // Requester can create/read own requests and upload own attachments, but cannot review or view analytics
    expect(hasPermission(["requester"], "requests:create")).toBe(true);
    expect(hasPermission(["requester"], "requests:read_own")).toBe(true);
    expect(hasPermission(["requester"], "attachments:upload_own")).toBe(true);
    expect(hasPermission(["requester"], "requests:read_all")).toBe(false);
    expect(hasPermission(["requester"], "requests:review_decision")).toBe(false);
    expect(hasPermission(["requester"], "analytics:view")).toBe(false);
    expect(hasPermission(["requester"], "roles:assign")).toBe(false);

    // Reviewer & leadership can read all requests, make review decisions, and view analytics/SLA
    expect(hasPermission(["reviewer"], "requests:read_all")).toBe(true);
    expect(hasPermission(["reviewer"], "requests:review_decision")).toBe(true);
    expect(hasPermission(["reviewer"], "analytics:view")).toBe(true);
    expect(hasPermission(["reviewer"], "roles:assign")).toBe(false);

    expect(hasPermission(["leadership"], "sla:view_dashboard")).toBe(true);
    expect(hasPermission(["leadership"], "analytics:export_csv")).toBe(true);
    expect(hasPermission(["leadership"], "roles:assign")).toBe(false);

    // Admin has full permissions including role assignment
    expect(hasPermission(["admin"], "roles:assign")).toBe(true);
    expect(ROLE_PERMISSION_MATRIX.admin).toContain("roles:assign");
  });

  it("defines strict denial and least-privilege fallback when a user has no recognized role (F21.1.3)", () => {
    // Unauthenticated user gets zero roles and zero permissions
    const unauth = resolveUserRoles(["admin"], { isAuthenticated: false });
    expect(unauth.recognizedRoles).toEqual([]);
    expect(unauth.effectivePrimaryRole).toBeNull();
    expect(unauth.reason).toBe("UNAUTHENTICATED");

    // Authenticated user with unrecognized roles and strict mode gets zero roles
    const noRoleStrict = resolveUserRoles(["guest", "invalid_role"], {
      isAuthenticated: true,
      allowLeastPrivilegeFallback: false,
    });
    expect(noRoleStrict.recognizedRoles).toEqual([]);
    expect(noRoleStrict.effectivePrimaryRole).toBeNull();
    expect(noRoleStrict.fallbackApplied).toBe(true);
    expect(noRoleStrict.reason).toBe("NO_RECOGNIZED_ROLE");
    expect(hasPermission(noRoleStrict.recognizedRoles, "requests:read_own")).toBe(false);

    // Authenticated user with least-privilege fallback enabled defaults only to requester
    const noRoleFallback = resolveUserRoles([], {
      isAuthenticated: true,
      allowLeastPrivilegeFallback: true,
    });
    expect(noRoleFallback.recognizedRoles).toEqual(["requester"]);
    expect(noRoleFallback.effectivePrimaryRole).toBe("requester");
    expect(noRoleFallback.fallbackApplied).toBe(true);
    expect(hasPermission(noRoleFallback.recognizedRoles, "requests:read_own")).toBe(true);
    expect(hasPermission(noRoleFallback.recognizedRoles, "requests:review_decision")).toBe(false);
  });
});

describe("F21.2: User-Role Management (F21.2.1–F21.2.3)", () => {
  it("associates authenticated users with their validated roles and rejects missing userId (F21.2.1)", () => {
    expect(associateUserWithRoles({ userId: null, rawRoles: ["admin"] })).toBeNull();
    expect(associateUserWithRoles({ userId: "   ", rawRoles: ["admin"] })).toBeNull();

    const association = associateUserWithRoles({
      userId: "user-123",
      rawRoles: ["reviewer", "requester"],
    });
    expect(association).toEqual({
      userId: "user-123",
      systemRoles: ["reviewer", "requester"],
      portalRoles: ["admin", "requester"],
      primaryRole: "reviewer",
      fallbackApplied: false,
    });
  });

  it("retrieves user roles on sign-in and falls back safely to requester on query failure (F21.2.2)", async () => {
    const signedIn = await retrieveSignedInUserRoles("user-456", async () => ({
      data: [{ role: "leadership" }],
      error: null,
    }));
    expect(signedIn?.systemRoles).toEqual(["leadership"]);
    expect(signedIn?.portalRoles).toEqual(["leadership"]);
    expect(signedIn?.fallbackApplied).toBe(false);

    const onQueryError = await retrieveSignedInUserRoles("user-456", async () => ({
      data: null,
      error: { message: "connection timeout" },
    }));
    expect(onQueryError?.systemRoles).toEqual(["requester"]);
    expect(onQueryError?.portalRoles).toEqual(["requester"]);
    expect(onQueryError?.fallbackApplied).toBe(true);
  });

  it("enforces controlled role assignment and blocks unauthorized or self-demoting changes (F21.2.3)", () => {
    // Unauthenticated actor blocked
    expect(
      validateControlledRoleAssignment({
        actorUserId: null,
        actorRoles: ["admin"],
        targetUserId: "user-2",
        newRole: "reviewer",
      }),
    ).toMatchObject({ allowed: false, code: "UNAUTHENTICATED_ACTOR" });

    // Non-admin actor blocked
    expect(
      validateControlledRoleAssignment({
        actorUserId: "user-1",
        actorRoles: ["reviewer", "leadership"],
        targetUserId: "user-2",
        newRole: "reviewer",
      }),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN_ROLE_ASSIGNMENT" });

    // Admin self-demotion blocked
    expect(
      validateControlledRoleAssignment({
        actorUserId: "admin-1",
        actorRoles: ["admin"],
        targetUserId: "admin-1",
        newRole: "requester",
      }),
    ).toMatchObject({ allowed: false, code: "SELF_ADMIN_DEMOTION_BLOCKED" });

    // Valid admin role assignment allowed
    expect(
      validateControlledRoleAssignment({
        actorUserId: "admin-1",
        actorRoles: ["admin"],
        targetUserId: "user-2",
        newRole: "reviewer",
      }),
    ).toEqual({
      allowed: true,
      actorUserId: "admin-1",
      targetUserId: "user-2",
      assignedRole: "reviewer",
    });
  });
});

describe("F21.3: Front-End Authorization (F21.3.1–F21.3.3)", () => {
  it("restricts application pages and routes according to role (F21.3.1)", () => {
    // Public login page is always accessible
    expect(canAccessRoute([], "/login")).toBe(true);

    // Requester can access /, /submit, /tracking, /requests, but NOT /analytics or /sla
    expect(canAccessRoute(["requester"], "/")).toBe(true);
    expect(canAccessRoute(["requester"], "/submit")).toBe(true);
    expect(canAccessRoute(["requester"], "/tracking")).toBe(true);
    expect(canAccessRoute(["requester"], "/analytics")).toBe(false);
    expect(canAccessRoute(["requester"], "/sla")).toBe(false);

    // Reviewer, leadership, and admin can access /analytics and /sla
    expect(canAccessRoute(["reviewer"], "/analytics")).toBe(true);
    expect(canAccessRoute(["leadership"], "/analytics")).toBe(true);
    expect(canAccessRoute(["admin"], "/sla")).toBe(true);
  });

  it("computes action visibility and disabled flags to hide or disable unauthorized UI controls (F21.3.2)", () => {
    const requesterActions = getAuthorizedActionState(["requester"]);
    expect(requesterActions.canCreateRequest).toBe(true);
    expect(requesterActions.canViewOwnRequests).toBe(true);
    expect(requesterActions.canReviewRequest).toBe(false);
    expect(requesterActions.canViewAnalytics).toBe(false);
    expect(requesterActions.canExportAnalyticsCsv).toBe(false);
    expect(requesterActions.canViewSlaDashboard).toBe(false);
    expect(requesterActions.canManageRoles).toBe(false);

    const reviewerActions = getAuthorizedActionState(["reviewer"]);
    expect(reviewerActions.canReviewRequest).toBe(true);
    expect(reviewerActions.canViewAnalytics).toBe(true);
    expect(reviewerActions.canExportAnalyticsCsv).toBe(true);
    expect(reviewerActions.canViewSlaDashboard).toBe(true);
    expect(reviewerActions.canManageRoles).toBe(false);

    const adminActions = getAuthorizedActionState(["admin"]);
    expect(adminActions.canManageRoles).toBe(true);
  });

  it("builds an appropriate 401/403 unauthorized-access response for restricted pages and actions (F21.3.3)", () => {
    const unauth = buildUnauthorizedAccessResponse({
      isAuthenticated: false,
      userRoles: [],
      targetPath: "/analytics",
    });
    expect(unauth).toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      title: "Sign-In Required",
      requiredPermission: "analytics:view",
      redirectTo: "/login",
    });

    const forbidden = buildUnauthorizedAccessResponse({
      isAuthenticated: true,
      userRoles: ["requester"],
      targetPath: "/analytics",
    });
    expect(forbidden).toMatchObject({
      status: 403,
      code: "INSUFFICIENT_ROLE_PERMISSIONS",
      title: "Access Restricted",
      requiredPermission: "analytics:view",
      redirectTo: "/",
    });
  });
});

describe("F21.4 & F21.5: Back-End/Data Authorization & RBAC Security Verification", () => {
  it("permits each role's authorized backend operations (F21.4.1, F21.5.1)", () => {
    // Requester creating and reading own request
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-req-1",
        claimedActorUid: "user-req-1",
        userRoles: ["requester"],
        permission: "requests:create",
        resourceOwnerUid: "user-req-1",
      }),
    ).toEqual({
      authorized: true,
      boundUid: "user-req-1",
      permission: "requests:create",
    });

    // Reviewer reading another user's request and recording a decision
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-rev-1",
        userRoles: ["reviewer"],
        permission: "requests:read_own",
        resourceOwnerUid: "user-req-1",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-rev-1" });

    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-rev-1",
        userRoles: ["reviewer"],
        permission: "requests:review_decision",
        resourceOwnerUid: "user-req-1",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-rev-1" });

    // Leadership exporting analytics CSV and viewing SLA dashboard
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-lead-1",
        userRoles: ["leadership"],
        permission: "analytics:export_csv",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-lead-1" });

    // Admin assigning roles
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-admin-1",
        userRoles: ["admin"],
        permission: "roles:assign",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-admin-1" });
  });

  it("blocks prohibited actions and direct backend calls that bypass UI restrictions (F21.4.2, F21.5.2)", () => {
    // Unauthenticated direct backend call rejected with 401
    expect(
      authorizeBackendOperation({
        authenticatedUid: null,
        userRoles: ["admin"],
        permission: "requests:read_all",
      }),
    ).toMatchObject({
      authorized: false,
      status: 401,
      code: "UNAUTHENTICATED",
    });

    // Requester calling review_decision or analytics:export_csv directly against backend rejected with 403
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-req-1",
        userRoles: ["requester"],
        permission: "requests:review_decision",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "PERMISSION_DENIED",
    });

    // Reviewer attempting admin-only role assignment rejected with 403
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-rev-1",
        userRoles: ["reviewer"],
        permission: "roles:assign",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("restricts access to uploaded files and sensitive financial records across users (F21.4.3)", () => {
    // Owner can upload and read their own file
    expect(
      authorizeFinancialRecordAndFileAccess({
        authenticatedUid: "user-req-1",
        userRoles: ["requester"],
        recordOwnerUid: "user-req-1",
        storagePath: "user-req-1/req-100/1700000000000-quote.pdf",
        mode: "read",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-req-1" });

    // Another requester cannot read user-req-1's record or file
    expect(
      authorizeFinancialRecordAndFileAccess({
        authenticatedUid: "user-req-2",
        userRoles: ["requester"],
        recordOwnerUid: "user-req-1",
        storagePath: "user-req-1/req-100/1700000000000-quote.pdf",
        mode: "read",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "CROSS_USER_RESOURCE_DENIED",
    });

    // Reviewer CAN read user-req-1's file, but CANNOT upload into user-req-1's request bucket
    expect(
      authorizeFinancialRecordAndFileAccess({
        authenticatedUid: "user-rev-1",
        userRoles: ["reviewer"],
        recordOwnerUid: "user-req-1",
        storagePath: "user-req-1/req-100/1700000000000-quote.pdf",
        mode: "read",
      }),
    ).toMatchObject({ authorized: true, boundUid: "user-rev-1" });

    expect(
      authorizeFinancialRecordAndFileAccess({
        authenticatedUid: "user-rev-1",
        userRoles: ["reviewer"],
        recordOwnerUid: "user-req-1",
        storagePath: "user-req-1/req-100/1700000000000-quote.pdf",
        mode: "upload",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "CROSS_USER_RESOURCE_DENIED",
    });
  });

  it("detects and blocks privilege-escalation and identity-spoofing bypass attempts (F21.5.3)", () => {
    // 1. Payload UID spoofing (authenticated as user-req-2, claiming actor user-req-1)
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-req-2",
        claimedActorUid: "user-req-1",
        userRoles: ["requester"],
        permission: "requests:read_own",
        resourceOwnerUid: "user-req-1",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "UID_SPOOFING_DETECTED",
    });

    // 2. Storage path traversal attempt (`../`)
    expect(
      authorizeFinancialRecordAndFileAccess({
        authenticatedUid: "user-req-1",
        userRoles: ["requester"],
        recordOwnerUid: "user-req-1",
        storagePath: "user-req-1/../user-req-2/req-200/secret.pdf",
        mode: "read",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "CROSS_USER_RESOURCE_DENIED",
    });

    // 3. Forged/unrecognized role injection in client state (`"superadmin"`, `"root"`)
    expect(
      authorizeBackendOperation({
        authenticatedUid: "user-req-1",
        userRoles: ["superadmin", "root"],
        permission: "roles:assign",
      }),
    ).toMatchObject({
      authorized: false,
      status: 403,
      code: "PERMISSION_DENIED",
    });

    // 4. Non-admin attempting self-elevation to admin
    expect(
      validateControlledRoleAssignment({
        actorUserId: "user-req-1",
        actorRoles: ["requester"],
        targetUserId: "user-req-1",
        newRole: "admin",
      }),
    ).toMatchObject({
      allowed: false,
      code: "FORBIDDEN_ROLE_ASSIGNMENT",
    });
  });
});



