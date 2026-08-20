import { NextResponse } from "next/server";
import { getPiChangeDeliveryService } from "@/src/modules/pi-agent/runtime";
import { piChangeSubmitSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentChangeSubmission } from "@/src/modules/pi-agent/application/change-delivery-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { id } = await params;
    const input = piChangeSubmitSchema.parse(await parseJson(request));
    const result = await getPiChangeDeliveryService().submitChange(context, { ...input, sessionId: id, idempotencyKey });
    return NextResponse.json({ data: { submission: presentChangeSubmission(result.submission), validation: result.validation, created: result.created }, meta: { traceId: context.traceId } }, { status: result.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
