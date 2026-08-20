import { NextResponse } from "next/server";
import { getPiModelGateway, getPiTelemetryService } from "@/src/modules/pi-agent/runtime";
import { presentModelUsage, presentObservability } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const usage = await getPiModelGateway().listUsage(context, 500);
    const snapshot = await getPiTelemetryService().snapshot(context, usage);
    return NextResponse.json({ data: { ...presentObservability(snapshot), recentUsage: usage.slice(0, 100).map(presentModelUsage) }, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

