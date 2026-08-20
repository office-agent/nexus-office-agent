import { NextResponse } from "next/server";
import { getPiSecurityResilienceService } from "@/src/modules/pi-agent/runtime";
import { presentKillSwitch } from "@/src/modules/pi-agent/application/m31-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { id } = await params;
    const item = await getPiSecurityResilienceService().releaseKillSwitch(context, id);
    return NextResponse.json({ data: presentKillSwitch(item), meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
