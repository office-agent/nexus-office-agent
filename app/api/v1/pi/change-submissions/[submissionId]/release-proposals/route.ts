import { NextResponse } from "next/server";
import { getPiChangeDeliveryService } from "@/src/modules/pi-agent/runtime";
import { piReleaseProposalSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentOutbox, presentReleaseProposal } from "@/src/modules/pi-agent/application/change-delivery-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { submissionId } = await params;
    const input = piReleaseProposalSchema.parse(await parseJson(request));
    const result = await getPiChangeDeliveryService().proposeRelease(context, submissionId, { ...input, idempotencyKey });
    return NextResponse.json({ data: { proposal: presentReleaseProposal(result.proposal), outbox: presentOutbox(result.outbox), created: result.created }, meta: { traceId: context.traceId } }, { status: result.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
