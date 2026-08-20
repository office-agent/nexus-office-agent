import { NextResponse } from "next/server";
import { getPiModelGateway } from "@/src/modules/pi-agent/runtime";
import { piModelRouteDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentModelRoute } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const route = await getPiModelGateway().publishRoute(context, piModelRouteDraftSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentModelRoute(route), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
