import { NextResponse } from "next/server";
import { capacityPlanSchema } from "@/src/modules/enterprise-intelligence/application/schemas";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = capacityPlanSchema.parse(await parseJson(request));
    const data = await getEnterpriseIntelligenceService().saveCapacityPlan(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
