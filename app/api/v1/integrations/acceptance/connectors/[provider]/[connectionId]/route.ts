import { NextResponse } from "next/server";
import { z } from "zod";
import { getIntegrationAcceptanceService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const paramsSchema = z.object({ provider: z.enum(["feishu", "dingtalk", "wecom"]), connectionId: z.uuid() }).strict();
const bodySchema = z.object({}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ provider: string; connectionId: string }> }) {
  try {
    const parsed = paramsSchema.parse(await params);
    bodySchema.parse(await parseJson(request));
    const context = await resolveRequestContext(request);
    return NextResponse.json({ data: await getIntegrationAcceptanceService().runConnector(context, parsed.provider, parsed.connectionId), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
