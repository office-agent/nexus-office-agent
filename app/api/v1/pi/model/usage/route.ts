import { NextResponse } from "next/server";
import { getPiModelGateway } from "@/src/modules/pi-agent/runtime";
import { piModelUsageSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentModelUsage } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const input = piModelUsageSchema.parse(await parseJson(request));
    if (input.idempotencyKey !== idempotencyKey) throw new Error("PI_IDEMPOTENCY_KEY_MISMATCH");
    const record = await getPiModelGateway().recordUsage(context, input);
    return NextResponse.json({ data: presentModelUsage(record), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

