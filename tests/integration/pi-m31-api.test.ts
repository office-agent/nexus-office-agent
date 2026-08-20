// Requirements: PR-001, PR-005, SR-003, SR-005, SR-006, AC-013, DR-010
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getSecurity } from "@/app/api/v1/pi/admin/security/route";
import { POST as activateKillSwitch } from "@/app/api/v1/pi/admin/kill-switch/route";
import { POST as releaseKillSwitch } from "@/app/api/v1/pi/admin/kill-switch/[id]/release/route";
import { GET as getCapacityPolicies, POST as publishCapacityPolicy } from "@/app/api/v1/pi/admin/capacity-policies/route";
import { DELETE as clearFaults, POST as configureFault } from "@/app/api/v1/pi/admin/test/faults/route";

function jsonRequest(url: string, method: string, body: unknown, idempotencyKey: string) {
  return new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
}

describe("Pi M31 HTTP boundary", () => {
  it("exposes safety state without tenant or actor internals and releases a tenant kill switch", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const before = await getSecurity(new Request("http://localhost/api/v1/pi/admin/security"));
    expect(before.status).toBe(200);
    const activated = await activateKillSwitch(jsonRequest("/api/v1/pi/admin/kill-switch", "POST", { scope: "tenant", reasonCode: `M31_${suffix}` }, `kill-${suffix}`));
    expect(activated.status).toBe(201);
    const payload = await activated.json();
    expect(payload.data.scope).toBe("tenant");
    expect(JSON.stringify(payload)).not.toContain("tenantId");
    expect(JSON.stringify(payload)).not.toContain("actorId");
    const released = await releaseKillSwitch(new Request(`http://localhost/api/v1/pi/admin/kill-switch/${payload.data.id}/release`, { method: "POST", headers: { "idempotency-key": `release-${suffix}` } }), { params: Promise.resolve({ id: payload.data.id }) });
    expect(released.status).toBe(200);
    expect((await released.json()).data.status).toBe("released");
  });

  it("publishes capacity policy and keeps fault injection explicitly test-only", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const policy = await publishCapacityPolicy(jsonRequest("/api/v1/pi/admin/capacity-policies", "POST", { scope: "tenant", version: parseInt(suffix.slice(0, 6), 16) % 100000 + 1, maxConcurrentRuns: 2, maxQueueDepth: 4, maxPromptBytes: 10000, maxEventBytes: 20000 }, `capacity-${suffix}`));
    expect(policy.status).toBe(201);
    const policyBody = await policy.json();
    const listed = await getCapacityPolicies(new Request("http://localhost/api/v1/pi/admin/capacity-policies"));
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.some((item: { id: string }) => item.id === policyBody.data.id)).toBe(true);

    const fault = await configureFault(jsonRequest("/api/v1/pi/admin/test/faults", "POST", { target: "telemetry.write", errorCode: "M31_TEST_TELEMETRY", remaining: 1, ttlSeconds: 30 }, `fault-${suffix}`));
    expect(fault.status).toBe(201);
    const cleared = await clearFaults(new Request("http://localhost/api/v1/pi/admin/test/faults", { method: "DELETE", headers: { "idempotency-key": `fault-clear-${suffix}` } }));
    expect(cleared.status).toBe(200);
  });
});
