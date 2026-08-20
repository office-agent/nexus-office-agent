import { NextResponse } from "next/server";
import { controlAgentJobSchema } from "@/src/modules/agent/application/schemas";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const input = controlAgentJobSchema.parse(await parseJson(request));
    const { id } = await params;
    const result = await getAgentOrchestrator().controlJob(context, id, input);
    return NextResponse.json(
      { data: result, meta: { traceId: context.traceId } },
      { status: input.action === "retry" ? 202 : 200, headers: { location: `/api/v1/agent/jobs/${id}` } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
