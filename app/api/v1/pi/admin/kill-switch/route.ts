import { NextResponse } from "next/server";
import { getPiSecurityResilienceService } from "@/src/modules/pi-agent/runtime";
import { piKillSwitchDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentKillSwitch } from "@/src/modules/pi-agent/application/m31-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const item = await getPiSecurityResilienceService().activateKillSwitch(context, piKillSwitchDraftSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentKillSwitch(item), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
