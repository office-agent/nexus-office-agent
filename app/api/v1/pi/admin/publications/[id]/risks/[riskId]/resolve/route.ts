import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piReleaseRiskResolutionSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentRisk } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; riskId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { id, riskId } = await params; const risk = await getPiReleaseGovernanceService().resolveRisk(context, id, riskId, piReleaseRiskResolutionSchema.parse(await parseJson(request)).mitigationDigest); return NextResponse.json({ data: presentRisk(risk), meta: { traceId: context.traceId } }); } catch (error) { return applicationErrorResponse(error); }
}
