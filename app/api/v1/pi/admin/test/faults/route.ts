import { NextResponse } from "next/server";
import { getPiSecurityResilienceService } from "@/src/modules/pi-agent/runtime";
import { piFaultPlanDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    if (process.env.NODE_ENV === "production") throw new Error("PI_FAULT_INJECTION_DISABLED");
    const plan = await getPiSecurityResilienceService().configureFault(context, piFaultPlanDraftSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: { id: plan.id, target: plan.target, remaining: plan.remaining, expiresAt: plan.expiresAt }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    if (process.env.NODE_ENV === "production") throw new Error("PI_FAULT_INJECTION_DISABLED");
    await getPiSecurityResilienceService().clearFaults(context);
    return NextResponse.json({ data: { cleared: true }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
