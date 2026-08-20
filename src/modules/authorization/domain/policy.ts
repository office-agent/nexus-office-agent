import type { DataScope, RequestContext } from "@/src/platform/context/request-context";

export type Action = "read" | "create" | "update" | "delete" | "approve" | "execute" | "admin";
export type RiskLevel = 0 | 1 | 2 | 3 | 4;

export type ResourceAttributes = {
  tenantId: string;
  type: string;
  id: string;
  ownerId?: string;
  teamId?: string;
  orgUnitId?: string;
  projectId?: string;
  classification?: "public" | "internal" | "confidential" | "restricted";
  state?: string;
};

export type AccessRequest = {
  context: RequestContext;
  action: Action;
  resource: ResourceAttributes;
  requestedFields?: string[];
  allowedFields?: string[];
  agent?: {
    toolPermission: string;
    toolRisk: RiskLevel;
    maxAutomaticRisk: RiskLevel;
  };
};

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  requiresConfirmation: boolean;
  visibleFields: string[];
};

function matchesPermission(permissions: string[], resourceType: string, action: Action): boolean {
  const exact = `${resourceType}:${action}`;
  return permissions.some(
    (permission) =>
      permission === "*" ||
      permission === exact ||
      permission === `${resourceType}:*` ||
      permission === `*:${action}`,
  );
}

function scopeAllows(scope: DataScope, actorId: string, resource: ResourceAttributes): boolean {
  switch (scope.type) {
    case "tenant":
      return true;
    case "self":
      return resource.id === actorId;
    case "owned":
      return resource.ownerId === actorId;
    case "team":
      return Boolean(resource.teamId && scope.teamIds.includes(resource.teamId));
    case "org_subtree":
      return Boolean(resource.orgUnitId && scope.orgUnitIds.includes(resource.orgUnitId));
    case "project":
      return Boolean(resource.projectId && scope.projectIds.includes(resource.projectId));
    case "explicit":
      return scope.resourceIds.includes(resource.id);
  }
}

export function evaluateAccess(request: AccessRequest): PolicyDecision {
  const { context, resource, action, requestedFields = [], allowedFields = [] } = request;
  if (context.tenantId !== resource.tenantId) {
    return { allowed: false, reason: "TENANT_MISMATCH", requiresConfirmation: false, visibleFields: [] };
  }
  if (!matchesPermission(context.permissions, resource.type, action)) {
    return { allowed: false, reason: "PERMISSION_MISSING", requiresConfirmation: false, visibleFields: [] };
  }
  if (!context.dataScopes.some((scope) => scopeAllows(scope, context.actorId, resource))) {
    return { allowed: false, reason: "DATA_SCOPE_DENIED", requiresConfirmation: false, visibleFields: [] };
  }
  if (request.agent && !matchesPermission(context.permissions, "tool", "execute")) {
    return { allowed: false, reason: "AGENT_TOOL_PERMISSION_MISSING", requiresConfirmation: false, visibleFields: [] };
  }
  if (request.agent && !context.permissions.includes(request.agent.toolPermission) && !context.permissions.includes("*")) {
    return { allowed: false, reason: "SPECIFIC_TOOL_PERMISSION_MISSING", requiresConfirmation: false, visibleFields: [] };
  }
  const visibleFields = requestedFields.length
    ? requestedFields.filter((field) => allowedFields.includes(field) || allowedFields.includes("*"))
    : [];
  if (requestedFields.length > 0 && visibleFields.length !== requestedFields.length) {
    return { allowed: false, reason: "FIELD_ACCESS_DENIED", requiresConfirmation: false, visibleFields };
  }
  const requiresConfirmation = Boolean(request.agent && request.agent.toolRisk > request.agent.maxAutomaticRisk);
  return { allowed: true, reason: "ALLOWED", requiresConfirmation, visibleFields };
}

