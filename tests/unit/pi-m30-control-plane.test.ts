// Requirements: PR-010, AR-006, SR-005, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import { EnterpriseModelGateway } from "@/src/modules/pi-agent/application/model-gateway";
import { PiQuotaService } from "@/src/modules/pi-agent/application/quota-service";
import { PiTelemetryService } from "@/src/modules/pi-agent/application/telemetry-evaluation";
import type { PiModelDataClassification } from "@/src/modules/pi-agent/domain/model-contracts";
import { InMemoryPiModelRouteStore, InMemoryPiObservabilityStore, InMemoryPiQuotaStore } from "@/src/modules/pi-agent/infrastructure/m30-store";

const context = (tenantId = "tenant-a", actorId = "actor-a"): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "request-session",
  channel: "web",
  traceId: `m30-${tenantId}-${actorId}`,
  roles: [],
  permissions: ["pi:model:read", "pi:model:admin", "pi:model:usage", "pi:model:cancel", "pi:usage:read", "pi:audit:read", "pi:audit:write", "pi:telemetry:write", "pi:evaluation:write", "pi:quota:read", "pi:quota:admin"],
  dataScopes: [{ type: "tenant" }],
});

const routeDraft = {
  routeId: "private-coding",
  version: "1.0.0",
  provider: "internal",
  model: "coding-large",
  region: "cn-shanghai",
  egress: "private" as const,
  allowedDataClassifications: ["public", "internal", "confidential", "restricted"] as PiModelDataClassification[],
  fallbackRouteIds: [],
  maxInputTokens: 1000,
  maxOutputTokens: 500,
  inputCostMicrosPerMillion: 1000,
  outputCostMicrosPerMillion: 2000,
};

describe("Pi M30 local control plane", () => {
  it("keeps restricted data away from a public route and fails closed without a provider", async () => {
    const store = new InMemoryPiModelRouteStore();
    const gateway = new EnterpriseModelGateway({ store });
    const publicRoute = await gateway.publishRoute(context(), { ...routeDraft, routeId: "public-review", egress: "public", allowedDataClassifications: ["public", "internal"] as PiModelDataClassification[] });
    await gateway.approveRoute(context(), publicRoute.routeId, publicRoute.version);
    const denied = await gateway.authorizePrompt(context(), { routeId: publicRoute.routeId, dataClassification: "restricted", inputTokens: 10, outputTokens: 10, promptDigest: sha256("secret") });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("data_classification_denied");
    const iterator = gateway.streamCompletion(context(), { routeId: publicRoute.routeId, dataClassification: "public", inputTokens: 10, promptDigest: sha256("public") })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("PI_MODEL_GATEWAY_NOT_READY");
  });

  it("records model usage once and calculates cost from the approved route", async () => {
    const store = new InMemoryPiModelRouteStore();
    const gateway = new EnterpriseModelGateway({ store });
    const route = await gateway.publishRoute(context(), routeDraft);
    await gateway.approveRoute(context(), route.routeId, route.version);
    const input = { usageId: "usage-1", routeId: route.routeId, provider: route.provider, model: route.model, dataClassification: "confidential" as const, inputTokens: 200, outputTokens: 100, latencyMs: 42, status: "succeeded" as const, idempotencyKey: "usage-key-1", traceId: context().traceId };
    const first = await gateway.recordUsage(context(), input);
    const repeated = await gateway.recordUsage(context(), { ...input, usageId: "usage-2" });
    expect(first.costMicros).toBe(1);
    expect(repeated.usageId).toBe(first.usageId);
    expect((await gateway.listUsage(context())).length).toBe(1);
    expect((await gateway.listUsage(context("tenant-b", "actor-b"))).length).toBe(0);
  });

  it("creates a regression alert from a failed evaluation without storing raw output", async () => {
    const store = new InMemoryPiObservabilityStore();
    const service = new PiTelemetryService(store);
    await service.recordMetric(context(), { traceId: "trace-1", name: "tool.error.count", value: 2, unit: "count", dimensions: { tool: "workspace_read" } });
    const result = await service.recordEvaluation(context(), { suiteId: "coding-regression", caseId: "case-1", score: 0.4, threshold: 0.8, metricSummary: { correctness: 0.4 }, outputDigest: sha256("raw-secret") });
    const snapshot = await service.snapshot(context());
    expect(result.status).toBe("failed");
    expect(result.correctionRequired).toBe(true);
    expect(snapshot.alerts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("raw-secret");
  });

  it("atomically rejects quota over-admission and over-consumption", async () => {
    const service = new PiQuotaService(new InMemoryPiQuotaStore());
    const policy = await service.publishPolicy(context(), { scope: "tenant", version: 1, maxConcurrentRuns: 2, maxTokens: 100, maxCostMicros: 1000, maxStorageBytes: 10_000, maxToolCalls: 20, status: "active" });
    const reservation = await service.reserve(context(), { policyId: policy.id, idempotencyKey: "quota-1", requested: { concurrentRuns: 1, tokens: 80, costMicros: 100, storageBytes: 10, toolCalls: 2 } });
    expect(reservation.status).toBe("active");
    await expect(service.reserve(context(), { policyId: policy.id, idempotencyKey: "quota-2", requested: { concurrentRuns: 1, tokens: 30, costMicros: 100, storageBytes: 10, toolCalls: 2 } })).rejects.toThrow("PI_QUOTA_EXCEEDED");
    await expect(service.consume(context(), reservation.id, { concurrentRuns: 1, tokens: 81, costMicros: 100, storageBytes: 10, toolCalls: 2 })).rejects.toThrow("PI_QUOTA_USAGE_EXCEEDS_RESERVATION");
    const consumed = await service.consume(context(), reservation.id, { concurrentRuns: 1, tokens: 80, costMicros: 100, storageBytes: 10, toolCalls: 2 });
    expect(consumed.status).toBe("consumed");
    await expect(service.release(context(), reservation.id)).rejects.toThrow("PI_QUOTA_RESERVATION_STATE_CONFLICT");
  });
});
