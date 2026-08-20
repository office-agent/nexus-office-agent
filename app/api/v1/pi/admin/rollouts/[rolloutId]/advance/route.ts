import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { presentRollout } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ rolloutId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { rolloutId } = await params; const rollout = await getPiReleaseGovernanceService().advanceRollout(context, rolloutId); return NextResponse.json({ data: presentRollout(rollout), meta: { traceId: context.traceId } }); } catch (error) { return applicationErrorResponse(error); }
}
