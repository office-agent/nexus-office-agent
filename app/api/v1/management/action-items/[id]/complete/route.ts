import { NextResponse } from "next/server";
import { completeActionSchema } from "@/src/modules/management-loop/application/schemas";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { evidence, version } = completeActionSchema.parse(await parseJson(request));
    const { id } = await params;
    const actionItem = await getManagementLoopService().completeAction(context, id, evidence, version);
    return NextResponse.json({ data: actionItem, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
