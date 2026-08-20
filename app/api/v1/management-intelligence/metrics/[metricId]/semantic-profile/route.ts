import { NextResponse } from "next/server";
import { metricSemanticProfileSchema } from "@/src/modules/management-intelligence/application/schemas";
import { getManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function PUT(request: Request, { params }: { params: Promise<{ metricId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { metricId } = await params;
    const input = metricSemanticProfileSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getManagementIntelligenceService().upsertMetricProfile(context, metricId, input), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
