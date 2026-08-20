import { NextResponse } from "next/server";
import { metricObservationSchema } from "@/src/modules/enterprise-intelligence/application/schemas";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = metricObservationSchema.parse(await parseJson(request));
    const data = await getEnterpriseIntelligenceService().recordMetricObservation(context, id, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
