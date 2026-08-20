import { NextResponse } from "next/server";
import { getPiPreproductionService } from "@/src/modules/pi-agent/runtime";
import { presentSecretLease } from "@/src/modules/pi-agent/application/m32-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ leaseId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { leaseId } = await params;
    const lease = await getPiPreproductionService().revokeSecretLease(context, leaseId);
    return NextResponse.json({ data: presentSecretLease(lease), meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
