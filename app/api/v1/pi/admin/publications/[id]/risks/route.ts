import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piReleaseRiskDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentRisk } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { id } = await params; const risk = await getPiReleaseGovernanceService().recordRisk(context, id, piReleaseRiskDraftSchema.parse(await parseJson(request))); return NextResponse.json({ data: presentRisk(risk), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
