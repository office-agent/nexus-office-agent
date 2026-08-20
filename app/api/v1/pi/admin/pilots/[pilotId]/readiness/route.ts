import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { presentPilotReadiness } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { pilotId } = await params; const readiness = await getPiPilotService().evaluateReadiness(context, pilotId); return NextResponse.json({ data: presentPilotReadiness(readiness), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
