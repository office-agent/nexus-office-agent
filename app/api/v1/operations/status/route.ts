import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";
import { getProductionReadiness, getSafeRuntimeStatus } from "@/src/platform/config/runtime-config";
import { SLO_TARGETS, telemetrySnapshot } from "@/src/platform/observability/telemetry";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    if (!context.permissions.includes("platform:operations:read") && !context.roles.includes("enterprise_manager")) throw new Error("POLICY_DENIED:platform:operations:read");
    return NextResponse.json({
      data: {
        readiness: getProductionReadiness(),
        runtime: getSafeRuntimeStatus(),
        sloTargets: SLO_TARGETS,
        processMetrics: telemetrySnapshot(),
        notes: ["进程指标用于本地诊断；生产 SLO 以 OTLP 后端聚合值为准。", "响应不包含密钥值、连接串、消息正文或敏感 Prompt。"],
      },
      meta: { traceId: context.traceId },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
