import { NextResponse } from "next/server";
import { getPiModelGateway, getPiQuotaService } from "@/src/modules/pi-agent/runtime";
import { presentModelUsage, presentQuotaPolicy, presentQuotaUsage } from "@/src/modules/pi-agent/application/m30-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const [usage, quota] = await Promise.all([getPiModelGateway().listUsage(context, 100), getPiQuotaService().summary(context)]);
    return NextResponse.json({ data: { model: { calls: usage.length, inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0), costMicros: usage.reduce((sum, item) => sum + item.costMicros, 0), recent: usage.map(presentModelUsage) }, quotas: quota.map((item) => ({ policy: presentQuotaPolicy(item.policy), scopeKey: item.scopeKey, usage: presentQuotaUsage(item.usage) })) }, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}

