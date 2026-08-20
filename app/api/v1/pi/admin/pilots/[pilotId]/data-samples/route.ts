import { NextResponse } from "next/server";
import { getPiPilotService } from "@/src/modules/pi-agent/runtime";
import { piPilotDataSampleDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentDataSample } from "@/src/modules/pi-agent/application/m33-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { pilotId } = await params; const sample = await getPiPilotService().recordDataSample(context, pilotId, piPilotDataSampleDraftSchema.parse(await parseJson(request))); return NextResponse.json({ data: presentDataSample(sample), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
