import { NextResponse } from "next/server";
import { getPiModelGateway, getPiPilotService, getPiPreproductionService, getPiQuotaService, getPiReleaseGovernanceService, getPiSecurityResilienceService, getPiTelemetryService } from "@/src/modules/pi-agent/runtime";
import { presentModelRoute, presentModelUsage, presentObservability, presentQuotaPolicy, presentQuotaUsage } from "@/src/modules/pi-agent/application/m30-presenter";
import { presentResilience } from "@/src/modules/pi-agent/application/m31-presenter";
import { presentPreproduction } from "@/src/modules/pi-agent/application/m32-presenter";
import { presentPilotSnapshot } from "@/src/modules/pi-agent/application/m33-presenter";
import { presentReleaseGovernance } from "@/src/modules/pi-agent/application/m34-presenter";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const canReadPreproduction = context.channel === "system" || context.permissions.includes("pi:preproduction:read");
    const canReadPilot = context.channel === "system" || context.permissions.includes("pi:pilot:read");
    const canReadReleaseGovernance = context.channel === "system" || context.permissions.includes("pi:release:read");
    const [routes, usage, quota, resilience, preproduction, pilot, releaseGovernance] = await Promise.all([
      getPiModelGateway().listRoutes(context), getPiModelGateway().listUsage(context, 500), getPiQuotaService().summary(context), getPiSecurityResilienceService().snapshot(context),
      canReadPreproduction ? getPiPreproductionService().snapshot(context) : Promise.resolve(null),
      canReadPilot ? getPiPilotService().snapshot(context) : Promise.resolve(null),
      canReadReleaseGovernance ? getPiReleaseGovernanceService().snapshot(context) : Promise.resolve(null),
    ]);
    const snapshot = await getPiTelemetryService().snapshot(context, usage);
    return NextResponse.json({ data: { models: routes.map(presentModelRoute), observability: presentObservability(snapshot), recentUsage: usage.slice(0, 20).map(presentModelUsage), quotas: quota.map((item) => ({ policy: presentQuotaPolicy(item.policy), usage: presentQuotaUsage(item.usage), scopeKey: item.scopeKey })), resilience: presentResilience(resilience), preproduction: preproduction ? presentPreproduction(preproduction) : { releases: [], readiness: [], secretLeases: [], events: [], generatedAt: new Date().toISOString() }, pilot: pilot ? presentPilotSnapshot(pilot) : { pilots: [], participants: [], journeys: [], observations: [], dataSamples: [], incidents: [], readiness: [], events: [], generatedAt: new Date().toISOString() }, releaseGovernance: releaseGovernance ? presentReleaseGovernance(releaseGovernance) : { publications: [], gates: [], risks: [], approvals: [], rollouts: [], evaluations: [], gateEvaluations: [], events: [], generatedAt: new Date().toISOString() } }, meta: { traceId: context.traceId } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
