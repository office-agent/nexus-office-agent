import { NextResponse } from "next/server";
import { getPiTelemetryService } from "@/src/modules/pi-agent/runtime";
import { piTraceSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = piTraceSchema.parse(await parseJson(request));
    const { startedAt: _startedAt, ...traceInput } = input;
    void _startedAt;
    const trace = await getPiTelemetryService().recordTrace(context, traceInput);
    return NextResponse.json({ data: { id: trace.id, traceId: trace.traceId, status: trace.status, dataClassification: trace.dataClassification, durationMs: trace.durationMs, errorCode: trace.errorCode, startedAt: trace.startedAt, endedAt: trace.endedAt }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
