import { NextResponse } from "next/server";
import { transitionEnterpriseCaseSchema } from "@/src/modules/management-intelligence/application/schemas";
import { getManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = transitionEnterpriseCaseSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getManagementIntelligenceService().transitionCase(context, id, input), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
