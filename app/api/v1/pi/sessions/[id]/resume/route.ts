import { NextResponse } from "next/server";
import { getPiSessionTreeService } from "@/src/modules/pi-agent/runtime";
import { piResumeSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = piResumeSchema.parse(await parseJson(request));
    const history = await getPiSessionTreeService().resume(context, id, input.branchId);
    return NextResponse.json({ data: history, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
