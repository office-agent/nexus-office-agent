import { NextResponse } from "next/server";
import { versionSchema } from "@/src/modules/enterprise-governance/application/schemas";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request); const { id } = await params; const { version } = versionSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getEnterpriseGovernanceService().approveOrganizationChange(context, id, version), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
