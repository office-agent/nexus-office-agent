import { NextResponse } from "next/server";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    return NextResponse.json({ data: await getEnterpriseGovernanceService().workspace(context), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return applicationErrorResponse(error); }
}
