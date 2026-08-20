import { NextResponse } from "next/server";
import { z } from "zod";
import { getTestNotificationService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const bodySchema = z.object({
  provider: z.enum(["feishu", "dingtalk", "wecom"]),
  connectionId: z.string().uuid(),
  recipientType: z.enum(["user", "chat"]),
  externalRecipientId: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();

export async function POST(request: Request) {
  try {
    const input = bodySchema.parse(await parseJson(request));
    const context = await resolveRequestContext(request);
    const data = await getTestNotificationService().prepare(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
