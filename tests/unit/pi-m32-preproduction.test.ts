// Requirements: PR-008, PR-009, SR-005, AC-010, AC-013, DR-010
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpAuditScopePreproductionProbe, PiPreproductionService, type PiPreproductionProbe } from "@/src/modules/pi-agent/application/preproduction-service";
import { InMemoryPiPreproductionStore } from "@/src/modules/pi-agent/infrastructure/m32-store";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiReadinessCheck, PiReleaseCandidate } from "@/src/modules/pi-agent/domain/preproduction-contracts";
import type { McpAuditScopeReadiness } from "@/src/modules/pi-agent/domain/mcp-contracts";

const TENANT_A = "76000000-0000-4000-8000-000000000001";
const ACTOR_A = "76000000-0000-4000-8000-000000000002";
const TENANT_B = "76000000-0000-4000-8000-000000000011";
const ACTOR_B = "76000000-0000-4000-8000-000000000012";
const DIGEST = "a".repeat(64);

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return {
    tenantId, actorId, sessionId: randomUUID(), channel: "web", traceId: `m32-${tenantId}`, roles: [],
    permissions: ["pi:release:propose", "pi:preproduction:read", "pi:secret:lease", "pi:secret:revoke"], dataScopes: [{ type: "tenant" }],
  };
}

function draft(version: string) {
  return { version, imageDigest: DIGEST, manifestDigest: "b".repeat(64), signatureDigest: "c".repeat(64), sbomDigest: "d".repeat(64) };
}

class PassingProbe implements PiPreproductionProbe {
  async probe(): Promise<PiReadinessCheck[]> {
    return [{ id: "runtime.worker", category: "operations", status: "pass", message: "测试探针通过。", evidenceDigest: DIGEST }];
  }
}

describe("Pi M32 preproduction control plane", () => {
  it("fails closed until an injected readiness probe passes, then supports promotion and rollback", async () => {
    const store = new InMemoryPiPreproductionStore();
    const blocked = new PiPreproductionService(store);
    const owner = context();
    const candidate = await blocked.registerRelease(owner, draft("0.21.0"), "release-blocked");
    const readiness = await blocked.evaluateReadiness(owner, candidate.id);
    expect(readiness.ready).toBe(false);
    await expect(blocked.promoteRelease(owner, candidate.id)).rejects.toThrow("PI_PREPROD_NOT_READY");

    const passing = new PiPreproductionService(store, new PassingProbe());
    const readyCandidate = await passing.registerRelease(owner, draft("0.21.1"), "release-ready");
    const ready = await passing.evaluateReadiness(owner, readyCandidate.id);
    expect(ready.ready).toBe(true);
    const active = await passing.promoteRelease(owner, readyCandidate.id);
    expect(active.status).toBe("active");
    const second = await passing.registerRelease(owner, draft("0.21.2"), "release-second");
    await passing.evaluateReadiness(owner, second.id);
    const secondActive = await passing.promoteRelease(owner, second.id);
    expect(secondActive.status).toBe("active");
    expect((await passing.listReleases(owner)).find((item) => item.id === active.id)?.status).toBe("rolled_back");
    expect((await passing.rollbackRelease(owner, second.id)).status).toBe("rolled_back");
  });

  it("keeps Secret Lease references opaque, tenant-scoped, bounded and revocable", async () => {
    const service = new PiPreproductionService(new InMemoryPiPreproductionStore());
    const owner = context();
    const other = context(TENANT_B, ACTOR_B);
    await expect(service.issueSecretLease(owner, { reference: `secret://tenants/${TENANT_B}/model`, purpose: "model", audience: "runner", ttlSeconds: 30 })).rejects.toThrow("PI_SECRET_REFERENCE_SCOPE_INVALID");
    const lease = await service.issueSecretLease(owner, { reference: `secret://tenants/${TENANT_A}/model/provider`, purpose: "model", audience: "runner", ttlSeconds: 30 });
    expect(lease.referenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(lease)).not.toContain("secret://");
    await expect(service.revokeSecretLease(other, lease.id)).rejects.toThrow("PI_SECRET_LEASE_NOT_FOUND");
    expect((await service.assertLeaseActive(owner, lease.id)).id).toBe(lease.id);
    const revoked = await service.revokeSecretLease(owner, lease.id);
    expect(revoked.status).toBe("revoked");
    await expect(service.assertLeaseActive(owner, lease.id)).rejects.toThrow("PI_SECRET_LEASE_STATE_CONFLICT");
    expect((await service.listSecretLeases(other)).length).toBe(0);
  });

  it("records only safe readiness and control-plane events when a probe fails", async () => {
    const service = new PiPreproductionService(new InMemoryPiPreproductionStore());
    const owner = context();
    const candidate = await service.registerRelease(owner, draft("0.21.3"), "release-events");
    const snapshot = await service.evaluateReadiness(owner, candidate.id);
    const events = await service.listEvents(owner);
    expect(snapshot.failureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(events.some((item) => item.kind === "pi.preproduction.readiness_evaluated")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("secret://");
  });

  it("keeps the M26 audit scope constraint as an explicit preproduction blocker until validated", async () => {
    let state: McpAuditScopeReadiness = { ready: false, code: "PI_MCP_AUDIT_SCOPE_CONSTRAINT_UNVALIDATED" };
    const probe = new McpAuditScopePreproductionProbe({ async check() { return state; } });
    const release = {} as PiReleaseCandidate;
    await expect(probe.probe(context(), release)).resolves.toMatchObject([{ id: "mcp.audit.execution_scope", status: "fail" }]);
    state = { ready: true };
    await expect(probe.probe(context(), release)).resolves.toMatchObject([{ id: "mcp.audit.execution_scope", status: "pass" }]);
  });
});
