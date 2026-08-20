import { NextResponse } from "next/server";
import { saveClosureReviewSchema } from "@/src/modules/enterprise-governance/application/schemas";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function PUT(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try { const context = await resolveRequestContext(request); const { projectId } = await params; const input = saveClosureReviewSchema.parse(await parseJson(request)); return NextResponse.json({ data: await getEnterpriseGovernanceService().saveClosureReview(context, projectId, input), meta: { traceId: context.traceId } }); }
  catch (error) { return applicationErrorResponse(error); }
}
