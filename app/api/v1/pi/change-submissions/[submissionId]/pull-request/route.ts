import { NextResponse } from "next/server";
import { getPiChangeDeliveryService } from "@/src/modules/pi-agent/runtime";
import { presentOutbox, presentPullRequest } from "@/src/modules/pi-agent/application/change-delivery-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { submissionId } = await params;
    const result = await getPiChangeDeliveryService().createPullRequest(context, submissionId);
    return NextResponse.json({ data: { pullRequest: presentPullRequest(result.pullRequest), outbox: presentOutbox(result.outbox), created: result.created }, meta: { traceId: context.traceId } }, { status: result.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
