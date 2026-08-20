import { NextResponse } from "next/server";
import { getPiProfileRegistry } from "@/src/modules/pi-agent/runtime";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    assertPiPermission(context, "pi:catalog:read");
    const profiles = await getPiProfileRegistry().listProfiles(context);
    return NextResponse.json({
      data: profiles.map((profile) => ({
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
      meta: { traceId: context.traceId },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
