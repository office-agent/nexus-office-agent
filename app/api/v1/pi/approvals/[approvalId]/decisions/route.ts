import { NextResponse } from "next/server";
import { getPiApprovalService } from "@/src/modules/pi-agent/runtime";
import { piApprovalDecisionSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { approvalId } = await params;
    const input = piApprovalDecisionSchema.parse(await parseJson(request));
    const service = getPiApprovalService();
    const result = input.decision === "reject"
      ? await service.reject(context, approvalId, { proposalHash: input.proposalHash, idempotencyKey, comment: input.comment })
      : await service.recordDecision(context, approvalId, { proposalHash: input.proposalHash, idempotencyKey, comment: input.comment });
    return NextResponse.json({ data: {
      approval: { id: result.approval.id, status: result.approval.status, version: result.approval.version, proposalHash: result.approval.proposalHash, expiresAt: result.approval.expiresAt },
      decision: { id: result.decision.id, actorId: result.decision.actorId, decision: result.decision.decision, decisionDigest: result.decision.decisionDigest, createdAt: result.decision.createdAt },
      created: result.created,
    }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

