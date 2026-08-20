import { NextResponse } from "next/server";
import { confirmProposalSchema } from "@/src/modules/agent/application/schemas";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { proposalHash } = confirmProposalSchema.parse(await parseJson(request));
    const { id } = await params;
    const result = await getAgentOrchestrator().confirmProposal(context, id, proposalHash);
    return NextResponse.json(
      { data: result, meta: { traceId: context.traceId } },
      { status: 202, headers: { location: `/api/v1/agent/jobs/${result.job.id}` } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
