import { NextResponse } from "next/server";
import { confirmOperatingReviewSchema } from "@/src/modules/enterprise-intelligence/application/schemas";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const { version } = confirmOperatingReviewSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getEnterpriseIntelligenceService().confirmReview(context, id, version), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
