import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const diff = await getPiAgentService().diff(context, id);
    return NextResponse.json({ data: diff, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
