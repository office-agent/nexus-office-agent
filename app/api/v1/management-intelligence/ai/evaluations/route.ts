import { NextResponse } from "next/server";
import { aiGovernanceEvaluationSchema } from "@/src/modules/management-intelligence/application/schemas";
import { getManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = aiGovernanceEvaluationSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getManagementIntelligenceService().recordAiEvaluation(context, input), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
