import { NextResponse } from "next/server";
import { createProjectChangeSchema } from "@/src/modules/enterprise-governance/application/schemas";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request); const input = createProjectChangeSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getEnterpriseGovernanceService().createProjectChange(context, input), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
