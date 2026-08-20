import { NextResponse } from "next/server";
import { getPiModelGateway } from "@/src/modules/pi-agent/runtime";
import { piModelAuthorizationSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const authorization = await getPiModelGateway().authorizePrompt(context, piModelAuthorizationSchema.parse(await parseJson(request)));
    return NextResponse.json({ data: authorization, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

