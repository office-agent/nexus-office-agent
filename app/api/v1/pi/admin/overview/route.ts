import { NextResponse } from "next/server";
import { getPiMcpRegistry, getPiProfileRegistry, getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    assertPiPermission(context, "pi:catalog:read");
    const canReadRegistry = context.channel === "system" || context.permissions.includes("pi:registry:read");
    const canManageMcp = context.channel === "system" || context.permissions.includes("pi:mcp:admin");
    const [profiles, resources, servers, bindings] = await Promise.all([
      getPiProfileRegistry().listProfiles(context),
      canReadRegistry ? getPiResourceRegistry().listAdminResources(context) : Promise.resolve({ skills: [], artifacts: [] }),
      canManageMcp ? getPiMcpRegistry().listServers(context) : Promise.resolve([]),
      canManageMcp ? getPiMcpRegistry().listBindings(context) : Promise.resolve([]),
    ]);
    return NextResponse.json({
      data: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          version: profile.version,
          digest: profile.digest,
          description: profile.description,
          allowedTools: profile.allowedTools,
          allowedDataScopes: profile.allowedDataScopes,
          maxRiskLevel: profile.maxRiskLevel,
          networkPolicy: profile.networkPolicy,
          canModifyWorkspace: profile.canModifyWorkspace,
          canExecuteSandbox: profile.canExecuteSandbox,
          delegationPolicy: profile.delegationPolicy,
        })),
        resources,
        mcp: {
          servers: servers.map((server) => ({
            id: server.id,
            version: server.version,
            source: server.source,
            digest: server.digest,
            approvalStatus: server.approvalStatus,
            schemaDigest: server.schemaDigest,
            toolCount: server.tools.length,
            circuitState: server.circuitState,
            failureCount: server.failureCount,
            createdAt: server.createdAt,
            probedAt: server.probedAt,
          })),
          bindings: bindings.map((binding) => ({
            id: binding.id,
            serverId: binding.serverId,
            serverVersion: binding.serverVersion,
            serverDigest: binding.serverDigest,
            toolName: binding.toolName,
            exposedName: binding.exposedName,
            schemaDigest: binding.schemaDigest,
            riskLevel: binding.riskLevel,
            dataClassification: binding.dataClassification,
            allowedProfiles: binding.allowedProfiles,
            scope: binding.scope,
            status: binding.status,
            createdAt: binding.createdAt,
            updatedAt: binding.updatedAt,
          })),
        },
        capabilities: {
          canReadRegistry,
          canManageMcp,
          canPublishRegistry: context.channel === "system" || context.permissions.includes("pi:registry:write"),
          canApproveRegistry: context.channel === "system" || context.permissions.includes("pi:registry:approve"),
          canScanRegistry: context.channel === "system" || context.permissions.includes("pi:registry:scan"),
          canManageProfiles: context.channel === "system" || context.permissions.includes("pi:profile:admin"),
        },
      },
      meta: { traceId: context.traceId },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
