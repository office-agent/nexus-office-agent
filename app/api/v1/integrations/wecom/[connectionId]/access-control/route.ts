import { NextResponse } from "next/server";
import { getWecomAccessControlService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { connectionId } = await params;
    const data = await getWecomAccessControlService().inspect(context, connectionId);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
