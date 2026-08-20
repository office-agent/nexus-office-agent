import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const projectId = z.uuid().parse(new URL(request.url).searchParams.get("projectId"));
    const snapshot = await getManagementLoopService().getSnapshot(context, projectId);
    return NextResponse.json({ data: snapshot, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
