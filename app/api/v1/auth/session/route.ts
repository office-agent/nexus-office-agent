import { NextResponse } from "next/server";
import { applicationErrorResponse } from "@/src/platform/http/api-response";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    return NextResponse.json({
      authenticated: true,
      identity: { actorId: context.actorId, tenantId: context.tenantId, roles: context.roles, channel: context.channel },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
