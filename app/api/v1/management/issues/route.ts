import { NextResponse } from "next/server";
import { reportIssueSchema } from "@/src/modules/management-loop/application/schemas";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = reportIssueSchema.parse(await parseJson(request));
    const issue = await getManagementLoopService().reportIssue(context, input);
    return NextResponse.json({ data: issue, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
