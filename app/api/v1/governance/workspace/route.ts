import { NextResponse } from "next/server";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const runtime = getGovernanceRuntime();
    const [workflow, meetings, documents] = await Promise.all([
      runtime.workflow.snapshot(context), runtime.meetings.list(context), runtime.knowledge.listDocuments(context),
    ]);
    return NextResponse.json({ data: { workflow, meetings, documents }, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
