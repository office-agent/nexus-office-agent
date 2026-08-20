import { NextResponse } from "next/server";
import { getPiPreproductionService } from "@/src/modules/pi-agent/runtime";
import { piReleaseCandidateDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentRelease } from "@/src/modules/pi-agent/application/m32-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const release = await getPiPreproductionService().registerRelease(context, piReleaseCandidateDraftSchema.parse(await parseJson(request)), idempotencyKey);
    return NextResponse.json({ data: presentRelease(release), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
