import { NextResponse } from "next/server";
import { talentEvidenceSchema } from "@/src/modules/enterprise-intelligence/application/schemas";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = talentEvidenceSchema.parse(await parseJson(request));
    const data = await getEnterpriseIntelligenceService().prepareTalentEvidence(context, input.subjectUserId, input.purpose);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
