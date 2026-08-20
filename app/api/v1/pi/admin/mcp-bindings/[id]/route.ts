import { NextResponse } from "next/server";
import { getPiMcpRegistry } from "@/src/modules/pi-agent/runtime";
import { mcpBindingSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { id } = await params;
    const input = mcpBindingSchema.parse(await parseJson(request));
    const binding = await getPiMcpRegistry().bindTool(context, { ...input, bindingId: id });
    return NextResponse.json({ data: { id: binding.id, exposedName: binding.exposedName, serverId: binding.serverId, serverVersion: binding.serverVersion, schemaDigest: binding.schemaDigest, riskLevel: binding.riskLevel, dataClassification: binding.dataClassification, allowedProfiles: binding.allowedProfiles, scope: binding.scope, status: binding.status }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
