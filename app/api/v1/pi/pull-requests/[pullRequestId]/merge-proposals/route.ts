import { NextResponse } from "next/server";
import { getPiChangeDeliveryService } from "@/src/modules/pi-agent/runtime";
import { piMergeProposalSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentMergeProposal, presentOutbox } from "@/src/modules/pi-agent/application/change-delivery-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ pullRequestId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { pullRequestId } = await params;
    const input = piMergeProposalSchema.parse(await parseJson(request));
    const result = await getPiChangeDeliveryService().proposeMerge(context, pullRequestId, { ...input, idempotencyKey });
    return NextResponse.json({ data: { proposal: presentMergeProposal(result.proposal), outbox: presentOutbox(result.outbox), created: result.created }, meta: { traceId: context.traceId } }, { status: result.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
