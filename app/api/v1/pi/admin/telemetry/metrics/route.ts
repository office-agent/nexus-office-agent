import { NextResponse } from "next/server";
import { getPiTelemetryService } from "@/src/modules/pi-agent/runtime";
import { piMetricSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentMetric } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const metric = await getPiTelemetryService().recordMetric(context, piMetricSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: presentMetric(metric), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

