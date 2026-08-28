import { NextResponse } from "next/server";
import { updateTaskTemplateSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const body = await parseJson(request) as Record<string, unknown>;
    const input = updateTaskTemplateSchema.parse({ ...body, taskId: id });
    const result = await getTaskCommandService().updateTaskTemplate(context, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
