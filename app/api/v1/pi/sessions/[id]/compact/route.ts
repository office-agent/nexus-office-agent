import { NextResponse } from "next/server";
import { getPiSessionTreeService } from "@/src/modules/pi-agent/runtime";
import { piCompactSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new Error("PI_IDEMPOTENCY_KEY_REQUIRED");
    const input = piCompactSchema.parse(await parseJson(request));
    const summary = await getPiSessionTreeService().compact(context, id, { ...input, idempotencyKey });
    return NextResponse.json({ data: summary, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
