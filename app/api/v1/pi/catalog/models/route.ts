import { NextResponse } from "next/server";
import { getPiModelGateway } from "@/src/modules/pi-agent/runtime";
import { presentModelRoute } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const routes = await getPiModelGateway().listRoutes(context);
    const canAdminister = context.channel === "system" || context.permissions.includes("pi:model:admin");
    return NextResponse.json({ data: routes.filter((route) => canAdminister || route.status === "approved").map(presentModelRoute), meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

