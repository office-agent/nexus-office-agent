import { NextResponse } from "next/server";
import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { createPiSessionSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = createPiSessionSchema.parse(await parseJson(request));
    const session = await getPiAgentService().createSession(context, input);
    return NextResponse.json({ data: session, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const sessions = await getPiAgentService().listSessions(context);
    return NextResponse.json({ data: sessions, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
