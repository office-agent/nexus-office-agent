import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { piMessageSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const { message } = piMessageSchema.parse(await parseJson(request));
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    const run = await getPiAgentService().sendMessage(context, id, message, idempotencyKey);
    return NextResponse.json({ data: run, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
