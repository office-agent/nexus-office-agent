import { NextResponse } from "next/server";
import { appendTaskArtifactVersionSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = appendTaskArtifactVersionSchema.parse(await parseJson(request));
    const result = await getTaskCommandService().appendTaskArtifactVersion(context, id, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
