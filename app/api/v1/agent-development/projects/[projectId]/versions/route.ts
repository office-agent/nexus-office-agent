import { NextResponse } from "next/server";
import { getAgentDevelopmentService } from "@/src/modules/agent-development/runtime";
import { developmentVersionSchema } from "@/src/modules/agent-development/application/schemas";
import { presentAgentDevelopmentProject } from "@/src/modules/agent-development/application/presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const requestContext = await resolveRequestContext(request);
    const { projectId } = await context.params;
    const project = await getAgentDevelopmentService().recordVersion(requestContext, projectId, developmentVersionSchema.parse(await parseJson(request)), requireIdempotencyKey(request));
    return NextResponse.json({ data: presentAgentDevelopmentProject(project), meta: { traceId: requestContext.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
