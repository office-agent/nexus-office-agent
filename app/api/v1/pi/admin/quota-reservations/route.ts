import { NextResponse } from "next/server";
import { getPiQuotaService } from "@/src/modules/pi-agent/runtime";
import { piQuotaReserveSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentQuotaReservation } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const headerKey = requireIdempotencyKey(request);
    const input = piQuotaReserveSchema.parse(await parseJson(request));
    if (input.idempotencyKey !== headerKey) throw new Error("PI_IDEMPOTENCY_KEY_MISMATCH");
    const reservation = await getPiQuotaService().reserve(context, input);
    return NextResponse.json({ data: presentQuotaReservation(reservation), meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

