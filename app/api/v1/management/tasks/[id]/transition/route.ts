import { NextResponse } from "next/server";
import { transitionTaskSchema } from "@/src/modules/management-loop/application/schemas";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { status } = transitionTaskSchema.parse(await parseJson(request));
    const { id } = await params;
    const task = await getManagementLoopService().transitionTask(context, id, status);
    return NextResponse.json({ data: task, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
