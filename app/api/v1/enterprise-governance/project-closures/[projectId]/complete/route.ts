import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const schema = z.object({ closureVersion: z.number().int().positive(), projectVersion: z.number().int().positive() });
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try { const context = await resolveRequestContext(request); const { projectId } = await params; const input = schema.parse(await parseJson(request)); return NextResponse.json({ data: await getEnterpriseGovernanceService().approveAndCompleteProject(context, projectId, input.closureVersion, input.projectVersion), meta: { traceId: context.traceId } }); }
  catch (error) { return applicationErrorResponse(error); }
}
