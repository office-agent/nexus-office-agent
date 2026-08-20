import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { piCancelSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { runId } = await params;
    const input = piCancelSchema.parse(await parseJson(request));
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    const result = await getPiAgentService().cancelRun(context, runId, input.reason ?? "user_cancel", idempotencyKey);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
