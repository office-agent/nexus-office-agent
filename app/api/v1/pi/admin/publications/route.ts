import { NextResponse } from "next/server";
import { getPiReleaseGovernanceService } from "@/src/modules/pi-agent/runtime";
import { piPublicationDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { presentPublication } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { const context = await resolveRequestContext(request); return NextResponse.json({ data: (await getPiReleaseGovernanceService().listPublications(context)).map(presentPublication), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } }); } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request) {
  try { const context = await resolveRequestContext(request); const key = requireIdempotencyKey(request); const publication = await getPiReleaseGovernanceService().createPublication(context, piPublicationDraftSchema.parse(await parseJson(request)), key); return NextResponse.json({ data: presentPublication(publication), meta: { traceId: context.traceId } }, { status: 201 }); } catch (error) { return applicationErrorResponse(error); }
}
