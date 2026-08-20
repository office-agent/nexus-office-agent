import { NextResponse } from "next/server";
import { getPiApprovalService } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const approvals = await getPiApprovalService().list(context);
    return NextResponse.json({ data: approvals.map((approval) => ({
      id: approval.id,
      sessionId: approval.sessionId,
      runId: approval.runId,
      toolName: approval.toolName,
      profile: approval.profile,
      riskLevel: approval.riskLevel,
      preview: approval.preview,
      proposalHash: approval.proposalHash,
      requiredApproverIds: approval.requiredApproverIds,
      approvalMode: approval.approvalMode,
      status: approval.status,
      expiresAt: approval.expiresAt,
      version: approval.version,
      revalidationStatus: approval.revalidationStatus,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt,
    })), meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

