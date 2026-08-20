import { NextResponse } from "next/server";
import { publishDocumentSchema } from "@/src/modules/knowledge/application/schemas";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = publishDocumentSchema.parse(await parseJson(request));
    const data = await getGovernanceRuntime().knowledge.publish(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
