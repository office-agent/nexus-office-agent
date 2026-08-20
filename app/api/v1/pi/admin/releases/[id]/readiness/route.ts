import { NextResponse } from "next/server";
import { getPiPreproductionService } from "@/src/modules/pi-agent/runtime";
import { presentReadiness } from "@/src/modules/pi-agent/application/m32-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { id } = await params;
    const readiness = await getPiPreproductionService().evaluateReadiness(context, id);
    return NextResponse.json({ data: presentReadiness(readiness), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
