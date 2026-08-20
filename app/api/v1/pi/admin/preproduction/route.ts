import { NextResponse } from "next/server";
import { getPiPreproductionService } from "@/src/modules/pi-agent/runtime";
import { presentPreproduction } from "@/src/modules/pi-agent/application/m32-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const snapshot = await getPiPreproductionService().snapshot(context);
    return NextResponse.json({ data: presentPreproduction(snapshot), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
