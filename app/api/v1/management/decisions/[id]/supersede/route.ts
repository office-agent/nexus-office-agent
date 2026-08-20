import { NextResponse } from "next/server";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { supersedeDecisionSchema } from "@/src/modules/management-loop/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = supersedeDecisionSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getManagementLoopService().supersedeDecision(context, id, input), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
