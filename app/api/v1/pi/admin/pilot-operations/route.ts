import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { presentPilotSnapshot } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { const context = await resolveRequestContext(request); return NextResponse.json({ data: presentPilotSnapshot(await getPiPilotService().snapshot(context)), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } }); } catch (error) { return applicationErrorResponse(error); }
}
