import { NextResponse } from "next/server";
import { getPiQuotaService } from "@/src/modules/pi-agent/runtime";
import { piQuotaPolicySchema } from "@/src/modules/pi-agent/application/schemas";
import { presentQuotaPolicy } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const policies = await getPiQuotaService().listPolicies(context);
    return NextResponse.json({ data: policies.map(presentQuotaPolicy), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const policy = await getPiQuotaService().publishPolicy(context, piQuotaPolicySchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentQuotaPolicy(policy), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

