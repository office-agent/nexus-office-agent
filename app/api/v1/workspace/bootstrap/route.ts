import { NextResponse } from "next/server";
import { getWorkspaceBootstrapService } from "@/src/modules/workspace-bootstrap/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const data = await getWorkspaceBootstrapService().bootstrap(context);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
