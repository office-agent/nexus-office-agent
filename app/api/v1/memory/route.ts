import { NextResponse } from "next/server";
import { createLongTermMemorySchema, recallMemorySchema } from "@/src/modules/agent-memory/application/schemas";
import { getAgentMemoryService } from "@/src/modules/agent-memory/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const input = recallMemorySchema.parse({
      query: url.searchParams.get("query") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      includeShared: url.searchParams.get("includeShared") === "false" ? false : undefined,
    });
    const data = await getAgentMemoryService().recall(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = createLongTermMemorySchema.parse(await parseJson(request));
    const data = await getAgentMemoryService().remember(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return applicationErrorResponse(error); }
}
