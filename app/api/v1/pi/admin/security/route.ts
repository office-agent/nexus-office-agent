import { NextResponse } from "next/server";
import { getPiSecurityResilienceService } from "@/src/modules/pi-agent/runtime";
import { presentResilience, presentSecurityEvent } from "@/src/modules/pi-agent/application/m31-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const service = getPiSecurityResilienceService();
    const [snapshot, events] = await Promise.all([service.snapshot(context), service.listSecurityEvents(context, 100)]);
    return NextResponse.json({ data: { ...presentResilience(snapshot), events: events.map(presentSecurityEvent) }, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
