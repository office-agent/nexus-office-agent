import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { piPilotIncidentDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentIncident } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { pilotId } = await params; const incident = await getPiPilotService().recordIncident(context, pilotId, piPilotIncidentDraftSchema.parse(await parseJson(request))); return NextResponse.json({ data: presentIncident(incident), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
