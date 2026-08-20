import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { presentPublication } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const context = await resolveRequestContext(request); requireIdempotencyKey(request); const { id } = await params; const publication = await getPiReleaseGovernanceService().rollbackPublication(context, id); return NextResponse.json({ data: presentPublication(publication), meta: { traceId: context.traceId } }); } catch (error) { return applicationErrorResponse(error); }
}
