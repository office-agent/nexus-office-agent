import { NextResponse } from "next/server";
import { getAgentDevelopmentService } from "@/src/modules/agent-development/runtime";
import { developmentHandoffSchema } from "@/src/modules/agent-development/application/schemas";
import { presentAgentDevelopmentProject } from "@/src/modules/agent-development/application/presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const snapshot = await getAgentDevelopmentService().snapshot(context);
    return NextResponse.json({ data: { ...snapshot, projects: snapshot.projects.map(presentAgentDevelopmentProject) }, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const project = await getAgentDevelopmentService().handoff(context, developmentHandoffSchema.parse(await parseJson(request)), requireIdempotencyKey(request));
    return NextResponse.json({ data: presentAgentDevelopmentProject(project), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
