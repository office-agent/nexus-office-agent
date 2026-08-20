import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { presentPilot } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { pilotId } = await params; const pilot = await getPiPilotService().exitPilot(context, pilotId); return NextResponse.json({ data: presentPilot(pilot), meta: { traceId: context.traceId } }); } catch (error) { return applicationErrorResponse(error); }
}
