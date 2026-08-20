// Requirements: PR-005, PR-008, SR-005, AC-010, AC-013, DR-010
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getPreproduction } from "@/app/api/v1/pi/admin/preproduction/route";
import { POST as createRelease } from "@/app/api/v1/pi/admin/releases/route";
import { POST as evaluateReadiness } from "@/app/api/v1/pi/admin/releases/[id]/readiness/route";
import { POST as promoteRelease } from "@/app/api/v1/pi/admin/releases/[id]/promote/route";
import { POST as issueLease } from "@/app/api/v1/pi/admin/secret-leases/route";
import { POST as revokeLease } from "@/app/api/v1/pi/admin/secret-leases/[leaseId]/revoke/route";

const DIGEST = "2".repeat(64);

function jsonRequest(url: string, method: string, body: unknown, key: string) {
  return new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}

describe("Pi M32 HTTP boundary", () => {
  it("exposes fail-closed readiness and release state without tenant or actor internals", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const created = await createRelease(jsonRequest("/api/v1/pi/admin/releases", "POST", { version: "0.21.7", imageDigest: DIGEST, manifestDigest: "3".repeat(64), signatureDigest: "4".repeat(64), sbomDigest: "5".repeat(64) }, `m32-release-${suffix}`));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.data.status).toBe("candidate");
    expect(JSON.stringify(createdBody)).not.toContain("tenantId");
    expect(JSON.stringify(createdBody)).not.toContain("createdBy");

    const readiness = await evaluateReadiness(new Request("http://localhost/api/v1/pi/admin/releases/readiness", { method: "POST", headers: { "idempotency-key": `m32-readiness-${suffix}` } }), { params: Promise.resolve({ id: createdBody.data.id }) });
    expect(readiness.status).toBe(201);
    expect((await readiness.json()).data.ready).toBe(false);
    const promote = await promoteRelease(new Request("http://localhost/api/v1/pi/admin/releases/promote", { method: "POST", headers: { "idempotency-key": `m32-promote-${suffix}` } }), { params: Promise.resolve({ id: createdBody.data.id }) });
    expect(promote.status).toBe(409);
    expect((await promote.json()).error.code).toBe("PI_PREPROD_NOT_READY");

    const lease = await issueLease(jsonRequest("/api/v1/pi/admin/secret-leases", "POST", { reference: "secret://tenants/00000000-0000-4000-8000-000000000001/runner/model", purpose: "model", audience: "pi-runner", ttlSeconds: 30 }, `m32-lease-${suffix}`));
    expect(lease.status).toBe(201);
    const leaseBody = await lease.json();
    expect(leaseBody.data.referenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(leaseBody)).not.toContain("secret://");
    const revoked = await revokeLease(new Request(`http://localhost/api/v1/pi/admin/secret-leases/${leaseBody.data.id}/revoke`, { method: "POST", headers: { "idempotency-key": `m32-revoke-${suffix}` } }), { params: Promise.resolve({ leaseId: leaseBody.data.id }) });
    expect(revoked.status).toBe(200);

    const snapshot = await getPreproduction(new Request("http://localhost/api/v1/pi/admin/preproduction"));
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).data.releases.some((item: { id: string }) => item.id === createdBody.data.id)).toBe(true);
  });
});
