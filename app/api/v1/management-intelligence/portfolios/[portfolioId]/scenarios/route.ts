import { NextResponse } from "next/server";
import { createPortfolioScenarioSchema } from "@/src/modules/management-intelligence/application/schemas";
import { getManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ portfolioId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { portfolioId } = await params;
    const input = createPortfolioScenarioSchema.parse(await parseJson(request));
    return NextResponse.json({ data: await getManagementIntelligenceService().createScenario(context, portfolioId, input), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
