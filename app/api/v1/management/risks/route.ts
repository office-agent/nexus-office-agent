import { NextResponse } from "next/server";
import { identifyRiskSchema } from "@/src/modules/management-loop/application/schemas";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = identifyRiskSchema.parse(await parseJson(request));
    const risk = await getManagementLoopService().identifyRisk(context, input);
    return NextResponse.json({ data: risk, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
