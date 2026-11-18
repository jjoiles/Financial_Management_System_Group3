import { describe, expect, it } from "vitest";
import {
  hasPermission,
  isSystemRole,
  mapDatabaseRoleToPortalRole,
  resolveUserRoles,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
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
