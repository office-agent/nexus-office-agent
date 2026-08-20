import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piReleaseEvaluationDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentReleaseEvaluation } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { id } = await params; const evaluation = await getPiReleaseGovernanceService().recordEvaluation(context, id, piReleaseEvaluationDraftSchema.parse(await parseJson(request))); return NextResponse.json({ data: presentReleaseEvaluation(evaluation), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
