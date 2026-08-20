import { NextResponse } from "next/server";
import { getPiMcpRegistry } from "@/src/modules/pi-agent/runtime";
import { piProfileSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const profile = piProfileSchema.parse(new URL(request.url).searchParams.get("profile") ?? "integration");
    const tools = await getPiMcpRegistry().listTools(context, profile);
    return NextResponse.json({ data: tools, meta: { traceId: context.traceId, profile } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
