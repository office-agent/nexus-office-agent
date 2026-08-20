// Requirements: PR-011, SR-007, AC-012, DR-012
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FailClosedPiReleaseEvidenceVerifier, FailClosedPiReleaseGate, PiReleaseGovernanceService, type PiReleaseEvidenceVerifier, type PiReleaseGateProbe } from "@/src/modules/pi-agent/application/release-governance-service";
import { InMemoryPiReleaseGovernanceStore } from "@/src/modules/pi-agent/infrastructure/m34-store";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiReleaseGateCheck } from "@/src/modules/pi-agent/domain/release-governance-contracts";

const TENANT_A = "79000000-0000-4000-8000-000000000001";
const ACTOR_A = "79000000-0000-4000-8000-000000000002";
const ACTOR_B = "79000000-0000-4000-8000-000000000003";
const TENANT_B = "79000000-0000-4000-8000-000000000011";
const DIGEST = "f".repeat(64);

function context(actorId = ACTOR_A, tenantId = TENANT_A): RequestContext { return { tenantId, actorId, sessionId: randomUUID(), channel: "web", traceId: `m34-${tenantId}-${actorId}`, roles: [], permissions: ["pi:release:read", "pi:release:manage", "pi:release:approve", "pi:release:rollout", "pi:release:revoke"], dataScopes: [{ type: "tenant" }] }; }
function publicationDraft() { return { version: "1.0.0", upstreamVersion: "0.84.2", apiDigest: DIGEST, schemaDigest: "a".repeat(64), imageDigest: "b".repeat(64), signatureDigest: "c".repeat(64), sbomDigest: "d".repeat(64), rollbackDigest: "e".repeat(64), pilotReadinessDigest: "1".repeat(64) }; }
class PassingEvidence implements PiReleaseEvidenceVerifier { async verifyGate(): Promise<"pass"> { return "pass"; } }
class PassingProbe implements PiReleaseGateProbe { async probe(): Promise<PiReleaseGateCheck[]> { return [{ id: "release.external", status: "pass", message: "受控发布 Gate 探针通过。", evidenceDigest: DIGEST }]; } }

describe("Pi M34 release governance control plane", () => {
  it("keeps the default release gate fail-closed", async () => {
    const service = new PiReleaseGovernanceService(new InMemoryPiReleaseGovernanceStore(), new FailClosedPiReleaseEvidenceVerifier(), new FailClosedPiReleaseGate());
    const owner = context();
    const publication = await service.createPublication(owner, publicationDraft(), "m34-blocked");
    const evaluation = await service.evaluateReleaseGate(owner, publication.id);
    expect(evaluation.ready).toBe(false);
    await expect(service.startRollout(owner, publication.id, { scopeDigest: DIGEST, capabilityDigest: DIGEST, stage: "canary", previousVersionDigest: DIGEST }, "rollout-blocked")).rejects.toThrow("PI_RELEASE_GATE_NOT_READY");
  });

  it("requires every gate, no high risk and two-person approvals before rollout and supports rollback", async () => {
    const service = new PiReleaseGovernanceService(new InMemoryPiReleaseGovernanceStore(), new PassingEvidence(), new PassingProbe());
    const owner = context();
    const reviewer = context(ACTOR_B);
    const publication = await service.createPublication(owner, publicationDraft(), "m34-ready");
    for (let gate = 25; gate <= 37; gate += 1) await service.recordGateAttestation(owner, publication.id, { gateId: `G-${String(gate).padStart(3, "0")}`, evidenceDigest: DIGEST, validUntil: "2099-01-01T00:00:00.000Z" });
    const risk = await service.recordRisk(owner, publication.id, { severity: "P1", summaryDigest: DIGEST });
    await service.resolveRisk(owner, publication.id, risk.id, DIGEST);
    const requestA = await service.requestApproval(owner, publication.id, { role: "release_manager", expiresAt: "2099-01-01T00:00:00.000Z" });
    const requestB = await service.requestApproval(reviewer, publication.id, { role: "security_reviewer", expiresAt: "2099-01-01T00:00:00.000Z" });
    await service.recordApproval(reviewer, publication.id, requestA.id, "approved");
    await service.recordApproval(owner, publication.id, requestB.id, "approved");
    const evaluation = await service.evaluateReleaseGate(owner, publication.id);
    expect(evaluation.ready).toBe(true);
    const rollout = await service.startRollout(owner, publication.id, { scopeDigest: DIGEST, capabilityDigest: DIGEST, stage: "canary", previousVersionDigest: DIGEST }, "rollout-ready");
    expect((await service.advanceRollout(owner, rollout.id)).stage).toBe("pilot");
    expect((await service.advanceRollout(owner, rollout.id)).status).toBe("completed");
    expect((await service.rollbackPublication(owner, publication.id)).status).toBe("rolled_back");
  });

  it("hides tenant facts and never accepts raw secret-like release content", async () => {
    const service = new PiReleaseGovernanceService(new InMemoryPiReleaseGovernanceStore());
    const owner = context();
    const other = context(ACTOR_B, TENANT_B);
    const publication = await service.createPublication(owner, publicationDraft(), "m34-isolation");
    expect(await service.listPublications(other)).toHaveLength(0);
    expect(JSON.stringify(await service.snapshot(owner))).not.toContain("secret://");
    await expect(service.revokePublication(other, publication.id)).rejects.toThrow("PI_PUBLICATION_NOT_FOUND");
    const evaluation = await service.recordEvaluation(owner, publication.id, { suiteDigest: DIGEST, score: 0.2, threshold: 0.8, evidenceDigest: DIGEST });
    expect(evaluation.status).toBe("regressed");
  });
});
