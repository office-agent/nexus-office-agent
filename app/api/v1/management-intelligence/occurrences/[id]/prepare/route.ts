import { NextResponse } from "next/server";
import { getManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    return NextResponse.json({ data: await getManagementIntelligenceService().prepareOccurrence(context, id), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
