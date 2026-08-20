import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    const run = await getPiAgentService().interrupt(context, id, idempotencyKey);
    return NextResponse.json({ data: run, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
