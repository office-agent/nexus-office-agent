import { NextResponse } from "next/server";
import { getPiPreproductionService } from "@/src/modules/pi-agent/runtime";
import { piSecretLeaseDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentSecretLease } from "@/src/modules/pi-agent/application/m32-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const lease = await getPiPreproductionService().issueSecretLease(context, piSecretLeaseDraftSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentSecretLease(lease), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
