import { NextResponse } from "next/server";
import { getPiMcpRegistry } from "@/src/modules/pi-agent/runtime";
import { mcpServerRegistrationSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const input = mcpServerRegistrationSchema.parse(await parseJson(request));
    const server = await getPiMcpRegistry().registerServer(context, input);
    return NextResponse.json({ data: { id: server.id, version: server.version, digest: server.digest, approvalStatus: server.approvalStatus }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
