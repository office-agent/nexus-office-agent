import { NextResponse } from "next/server";
import { transitionPackageSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = transitionPackageSchema.parse(await parseJson(request));
    const task = await getTaskCommandService().transitionPackage(context, id, input);
    return NextResponse.json({ data: { task }, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
