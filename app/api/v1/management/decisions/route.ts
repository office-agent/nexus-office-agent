import { NextResponse } from "next/server";
import { recordDecisionSchema } from "@/src/modules/management-loop/application/schemas";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = recordDecisionSchema.parse(await parseJson(request));
    const result = await getManagementLoopService().recordDecision(context, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
