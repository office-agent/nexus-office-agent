import { NextResponse } from "next/server";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const job = await getAgentOrchestrator().getJob(context, id);
    return NextResponse.json({ data: { job }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
