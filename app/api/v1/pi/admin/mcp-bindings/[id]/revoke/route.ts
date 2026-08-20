import { NextResponse } from "next/server";
import { getPiMcpRegistry } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireIdempotencyKey(request);
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const binding = await getPiMcpRegistry().revokeBinding(context, id);
    return NextResponse.json({ data: { id: binding.id, exposedName: binding.exposedName, status: binding.status }, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
