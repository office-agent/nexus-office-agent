import { NextResponse } from "next/server";
import { initiateTaskHandoffSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const trail = await getTaskCommandService().taskHandoffTrail(context, id);
    return NextResponse.json({ data: trail, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = initiateTaskHandoffSchema.omit({ taskId: true }).parse(await parseJson(request));
    const result = await getTaskCommandService().initiateTaskHandoff(context, { ...input, taskId: id }, { source: "human" });
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: result.created ? 201 : 200 });
  } catch (error) { return applicationErrorResponse(error); }
}
