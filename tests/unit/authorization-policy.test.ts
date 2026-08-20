// Requirements: MR-008, MR-016, SR-001, SR-002, SR-004, SR-006, AC-003, AC-004
import { describe, expect, it } from "vitest";
import { evaluateAccess, type AccessRequest } from "@/src/modules/authorization/domain/policy";
import type { RequestContext } from "@/src/platform/context/request-context";

const context: RequestContext = {
  tenantId: "tenant-a",
  actorId: "user-1",
  sessionId: "session-1",
  channel: "web",
  traceId: "trace-1",
  roles: ["Manager"],
  permissions: ["project:read", "project:update", "tool:execute", "tool:project.task.create"],
  dataScopes: [{ type: "project", projectIds: ["project-1"] }],
};

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    context,
    action: "read",
    resource: {
      tenantId: "tenant-a",
      type: "project",
      id: "project-1",
      projectId: "project-1",
      classification: "internal",
    },
    ...overrides,
  };
}

describe("evaluateAccess", () => {
  it("allows a permitted resource inside the configured data scope", () => {
    expect(evaluateAccess(request())).toMatchObject({ allowed: true, reason: "ALLOWED" });
  });

  it("fails closed for a cross-tenant resource", () => {
    const decision = evaluateAccess(
      request({ resource: { tenantId: "tenant-b", type: "project", id: "project-1", projectId: "project-1" } }),
    );
    expect(decision).toEqual({ allowed: false, reason: "TENANT_MISMATCH", requiresConfirmation: false, visibleFields: [] });
  });

  it("denies a resource outside the user's data scope", () => {
    const decision = evaluateAccess(
      request({ resource: { tenantId: "tenant-a", type: "project", id: "project-2", projectId: "project-2" } }),
    );
    expect(decision.reason).toBe("DATA_SCOPE_DENIED");
  });

  it("denies partial field visibility instead of silently leaking a subset", () => {
    const decision = evaluateAccess(request({ requestedFields: ["name", "budget"], allowedFields: ["name"] }));
    expect(decision).toMatchObject({ allowed: false, reason: "FIELD_ACCESS_DENIED", visibleFields: ["name"] });
  });

  it("requires confirmation when a tool exceeds automatic risk", () => {
    const decision = evaluateAccess(
      request({
        action: "update",
        agent: { toolPermission: "tool:project.task.create", toolRisk: 3, maxAutomaticRisk: 2 },
      }),
    );
    expect(decision).toMatchObject({ allowed: true, requiresConfirmation: true });
  });

  it("denies a tool without its specific permission", () => {
    const decision = evaluateAccess(
      request({
        action: "update",
        agent: { toolPermission: "tool:finance.payment.create", toolRisk: 4, maxAutomaticRisk: 0 },
      }),
    );
    expect(decision.reason).toBe("SPECIFIC_TOOL_PERMISSION_MISSING");
  });
});
