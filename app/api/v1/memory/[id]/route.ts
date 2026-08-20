import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentMemoryService } from "@/src/modules/agent-memory/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const expireSchema = z.object({ version: z.number().int().positive() }).strict();

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = expireSchema.parse(await parseJson(request));
    await getAgentMemoryService().expire(context, z.uuid().parse(id), input.version);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return applicationErrorResponse(error); }
}
