// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import { GET as getModels } from "@/app/api/v1/pi/catalog/models/route";
import { POST as publishRoute } from "@/app/api/v1/pi/admin/model-routes/route";
import { POST as approveRoute } from "@/app/api/v1/pi/admin/model-routes/[routeId]/approve/route";
import { POST as recordUsage } from "@/app/api/v1/pi/model/usage/route";
import { GET as getUsage } from "@/app/api/v1/pi/usage/route";
import { GET as getOperations } from "@/app/api/v1/pi/admin/operations/route";
import { POST as publishPolicy } from "@/app/api/v1/pi/admin/quota-policies/route";
import { POST as reserveQuota } from "@/app/api/v1/pi/admin/quota-reservations/route";

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("Pi M30 HTTP boundary", () => {
  it("publishes, approves, authorizes and measures a route without exposing tenant internals", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const routeId = `m30-route-${suffix}`;
    const published = await publishRoute(jsonRequest("/api/v1/pi/admin/model-routes", { routeId, version: "1.0.0", provider: "internal", model: "coding-large", region: "cn-shanghai", egress: "private", allowedDataClassifications: ["public", "internal", "confidential", "restricted"], fallbackRouteIds: [], maxInputTokens: 1000, maxOutputTokens: 500, inputCostMicrosPerMillion: 1000, outputCostMicrosPerMillion: 2000 }, { "idempotency-key": `publish-${suffix}` }));
    expect(published.status).toBe(201);
    const publishedBody = await published.json();
    expect(publishedBody.data.routeId).toBe(routeId);
    expect(JSON.stringify(publishedBody)).not.toContain("tenantId");

    const approved = await approveRoute(jsonRequest(`/api/v1/pi/admin/model-routes/${routeId}/approve`, { version: "1.0.0" }, { "idempotency-key": `approve-${suffix}` }), { params: Promise.resolve({ routeId }) });
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.status).toBe("approved");

    const listed = await getModels(new Request("http://localhost/api/v1/pi/catalog/models"));
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.some((item: { routeId: string }) => item.routeId === routeId)).toBe(true);

    const usageKey = `usage-${suffix}`;
    const usage = await recordUsage(jsonRequest("/api/v1/pi/model/usage", { usageId: randomUUID(), routeId, provider: "internal", model: "coding-large", dataClassification: "confidential", inputTokens: 200, outputTokens: 100, latencyMs: 48, status: "succeeded", idempotencyKey: usageKey, traceId: sha256(`trace-${suffix}`) }, { "idempotency-key": usageKey }));
    expect(usage.status).toBe(201);
    expect((await usage.json()).data.costMicros).toBe(1);

    const summary = await getUsage(new Request("http://localhost/api/v1/pi/usage"));
    expect(summary.status).toBe(200);
    expect((await summary.json()).data.model.calls).toBeGreaterThanOrEqual(1);
  });

  it("keeps quota admission hard-fail and operations output secret-free", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const policy = await publishPolicy(jsonRequest("/api/v1/pi/admin/quota-policies", { scope: "tenant", version: 1, maxConcurrentRuns: 1, maxTokens: 10, maxCostMicros: 100, maxStorageBytes: 1000, maxToolCalls: 2, status: "active" }, { "idempotency-key": `policy-${suffix}` }));
    expect(policy.status).toBe(201);
    const policyId = (await policy.json()).data.id as string;
    const reserve = await reserveQuota(jsonRequest("/api/v1/pi/admin/quota-reservations", { policyId, idempotencyKey: `reserve-${suffix}`, requested: { concurrentRuns: 1, tokens: 10, costMicros: 10, storageBytes: 10, toolCalls: 1 } }, { "idempotency-key": `reserve-${suffix}` }));
    expect(reserve.status).toBe(201);
    const over = await reserveQuota(jsonRequest("/api/v1/pi/admin/quota-reservations", { policyId, idempotencyKey: `reserve-over-${suffix}`, requested: { concurrentRuns: 1, tokens: 1, costMicros: 1, storageBytes: 1, toolCalls: 1 } }, { "idempotency-key": `reserve-over-${suffix}` }));
    expect(over.status).toBe(429);

    const operations = await getOperations(new Request("http://localhost/api/v1/pi/admin/operations"));
    expect(operations.status).toBe(200);
    const body = await operations.json();
    expect(body.data).toHaveProperty("observability");
    expect(JSON.stringify(body)).not.toContain("endpointRef");
    expect(JSON.stringify(body)).not.toContain("credentialRef");
  });
});
