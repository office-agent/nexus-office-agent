import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piReleaseApprovalDecisionSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentApproval } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { id, approvalId } = await params; const decision = piReleaseApprovalDecisionSchema.parse(await parseJson(request)).decision; const approval = await getPiReleaseGovernanceService().recordApproval(context, id, approvalId, decision); return NextResponse.json({ data: presentApproval(approval), meta: { traceId: context.traceId } }); } catch (error) { return applicationErrorResponse(error); }
}
