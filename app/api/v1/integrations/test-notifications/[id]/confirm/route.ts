import { NextResponse } from "next/server";
import { z } from "zod";
import { getTestNotificationService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const bodySchema = z.object({
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  externalRecipientId: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();

export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const { id } = paramsSchema.parse(await route.params);
    const { proposalHash, externalRecipientId } = bodySchema.parse(await parseJson(request));
    const context = await resolveRequestContext(request);
    const data = await getTestNotificationService().confirm(context, id, proposalHash, externalRecipientId);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
