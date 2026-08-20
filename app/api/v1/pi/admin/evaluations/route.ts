import { NextResponse } from "next/server";
import { getPiTelemetryService } from "@/src/modules/pi-agent/runtime";
import { piEvaluationSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentEvaluation } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const result = await getPiTelemetryService().recordEvaluation(context, piEvaluationSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentEvaluation(result), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

