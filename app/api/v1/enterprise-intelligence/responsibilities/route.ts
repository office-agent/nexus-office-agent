import { NextResponse } from "next/server";
import { replaceResponsibilitiesSchema } from "@/src/modules/enterprise-intelligence/application/schemas";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function PUT(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = replaceResponsibilitiesSchema.parse(await parseJson(request));
    const data = await getEnterpriseIntelligenceService().replaceResponsibilities(context, input.resourceType, input.resourceId, input.assignments);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
