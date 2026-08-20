import { NextResponse } from "next/server";
import { z } from "zod";
import { getIntegrationAcceptanceService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const bodySchema = z.object({}).strict();

export async function POST(request: Request) {
  try {
    bodySchema.parse(await parseJson(request));
    const context = await resolveRequestContext(request);
    return NextResponse.json({ data: await getIntegrationAcceptanceService().runIdentity(context), meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
