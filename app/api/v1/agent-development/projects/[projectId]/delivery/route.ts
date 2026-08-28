import { NextResponse } from "next/server";
import { getAgentDevelopmentService } from "@/src/modules/agent-development/runtime";
import { developmentDeliverySchema } from "@/src/modules/agent-development/application/schemas";
import { presentAgentDevelopmentProject } from "@/src/modules/agent-development/application/presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const requestContext = await resolveRequestContext(request);
    const { projectId } = await context.params;
    const input = developmentDeliverySchema.parse(await parseJson(request));
    const project = await getAgentDevelopmentService().deliver(requestContext, projectId, input.projectVersion, requireIdempotencyKey(request));
    return NextResponse.json({ data: presentAgentDevelopmentProject(project), meta: { traceId: requestContext.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
