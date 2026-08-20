import { NextResponse } from "next/server";
import { createAgentRunSchema } from "@/src/modules/agent/application/schemas";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = createAgentRunSchema.parse(await parseJson(request));
    const orchestrator = getAgentOrchestrator();
    const run = await orchestrator.createRun(context, input);
    const proposal = run.output?.proposalId ? await orchestrator.getProposal(context, run.output.proposalId) : undefined;
    return NextResponse.json({
      answer: run.output?.content || "Agent 未生成有效结果。",
      runId: run.id,
      kind: run.output?.kind,
      citations: run.output?.citations || [],
      proposal,
      routing: run.output?.routing,
    });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
