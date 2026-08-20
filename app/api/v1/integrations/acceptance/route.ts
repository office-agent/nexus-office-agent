import { NextResponse } from "next/server";
import { getIntegrationAcceptanceService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    return NextResponse.json({ data: await getIntegrationAcceptanceService().overview(context), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return applicationErrorResponse(error); }
}
