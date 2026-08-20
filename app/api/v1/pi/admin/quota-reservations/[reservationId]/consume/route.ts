import { NextResponse } from "next/server";
import { getPiQuotaService } from "@/src/modules/pi-agent/runtime";
import { piQuotaReservationActionSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentQuotaReservation } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ reservationId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { reservationId } = await params;
    const { consumed } = piQuotaReservationActionSchema.parse(await parseJson(request));
    if (!consumed) throw new Error("PI_QUOTA_USAGE_INVALID");
    const reservation = await getPiQuotaService().consume(context, reservationId, consumed);
    return NextResponse.json({ data: presentQuotaReservation(reservation), meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

