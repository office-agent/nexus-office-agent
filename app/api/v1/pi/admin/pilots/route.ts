import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { piPilotDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentPilot } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { const context = await resolveRequestContext(request); return NextResponse.json({ data: (await getPiPilotService().listPilots(context)).map(presentPilot), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } }); } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request) {
  try { const context = await resolveRequestContext(request); const key = requireIdempotencyKey(request); const pilot = await getPiPilotService().createPilot(context, piPilotDraftSchema.parse(await parseJson(request)), key); return NextResponse.json({ data: presentPilot(pilot), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
