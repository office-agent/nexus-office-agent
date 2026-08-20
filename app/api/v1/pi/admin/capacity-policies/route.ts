import { NextResponse } from "next/server";
import { getPiSecurityResilienceService } from "@/src/modules/pi-agent/runtime";
import { piCapacityPolicyDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentCapacityPolicy } from "@/src/modules/pi-agent/application/m31-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const policies = await getPiSecurityResilienceService().listCapacityPolicies(context);
    return NextResponse.json({ data: policies.map(presentCapacityPolicy), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const policy = await getPiSecurityResilienceService().publishCapacityPolicy(context, piCapacityPolicyDraftSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentCapacityPolicy(policy), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
