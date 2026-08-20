import { NextResponse } from "next/server";
import { addApproverSchema } from "@/src/modules/workflow/application/schemas";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = addApproverSchema.parse(await parseJson(request));
    const data = await getGovernanceRuntime().workflow.addApprover(context, id, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
