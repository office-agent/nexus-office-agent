import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { piPilotParticipantDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentParticipant } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { pilotId } = await params; const participant = await getPiPilotService().addParticipant(context, pilotId, piPilotParticipantDraftSchema.parse(await parseJson(request))); return NextResponse.json({ data: presentParticipant(participant), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
