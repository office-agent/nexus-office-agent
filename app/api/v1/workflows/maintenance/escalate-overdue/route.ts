import { NextResponse } from "next/server";
import { escalateOverdueSchema } from "@/src/modules/workflow/application/schemas";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = escalateOverdueSchema.parse(await parseJson(request));
    const data = await getGovernanceRuntime().workflow.escalateOverdue(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
