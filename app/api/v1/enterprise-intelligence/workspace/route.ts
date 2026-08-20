import { NextResponse } from "next/server";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    return NextResponse.json({ data: await getEnterpriseIntelligenceService().workspace(context), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
