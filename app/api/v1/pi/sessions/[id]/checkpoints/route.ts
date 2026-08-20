import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { piCheckpointSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = piCheckpointSchema.parse(await parseJson(request));
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    const checkpointRequest = await getPiAgentService().createCheckpoint(context, id, input.label ?? "checkpoint", idempotencyKey);
    return NextResponse.json({ data: checkpointRequest, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const checkpoints = await getPiAgentService().checkpoints(context, id);
    return NextResponse.json({ data: checkpoints, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
