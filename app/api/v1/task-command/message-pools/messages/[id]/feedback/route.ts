import { NextResponse } from "next/server";
import { appendPoolFeedbackSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const body = await parseJson(request);
    const input = appendPoolFeedbackSchema.parse({ ...(body as Record<string, unknown>), messageId: id });
    const feedback = await getTaskCommandService().appendPoolFeedback(context, input);
    return NextResponse.json({ data: { feedback }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
