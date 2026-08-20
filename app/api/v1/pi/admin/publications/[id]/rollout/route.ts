import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piRolloutDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentRollout } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const context = await resolveRequestContext(request); const key = requireIdempotencyKey(request); const { id } = await params; const rollout = await getPiReleaseGovernanceService().startRollout(context, id, piRolloutDraftSchema.parse(await parseJson(request)), key); return NextResponse.json({ data: presentRollout(rollout), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
