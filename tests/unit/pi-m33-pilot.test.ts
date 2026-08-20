// Requirements: PR-010, SR-006, AC-011, DR-011
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FailClosedPiPilotEvidenceVerifier, FailClosedPiPilotProbe, PiPilotService, type PiPilotEvidenceVerifier, type PiPilotReadinessProbe } from "@/src/modules/pi-agent/application/pilot-service";
import { InMemoryPiPilotStore } from "@/src/modules/pi-agent/infrastructure/m33-store";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiPilotReadinessCheck } from "@/src/modules/pi-agent/domain/pilot-contracts";

const TENANT_A = "78000000-0000-4000-8000-000000000001";
const ACTOR_A = "78000000-0000-4000-8000-000000000002";
const TENANT_B = "78000000-0000-4000-8000-000000000011";
const ACTOR_B = "78000000-0000-4000-8000-000000000012";
const DIGEST = "a".repeat(64);

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return { tenantId, actorId, sessionId: randomUUID(), channel: "web", traceId: `m33-${tenantId}`, roles: [], permissions: ["pi:pilot:read", "pi:pilot:manage", "pi:pilot:exit"], dataScopes: [{ type: "tenant" }] };
}

class PassingEvidence implements PiPilotEvidenceVerifier {
  async verifyJourney() { return "verified" as const; }
  async verifyObservation() { return "verified" as const; }
  async verifyDataSample() { return "verified" as const; }
}
class PassingProbe implements PiPilotReadinessProbe { async probe(): Promise<PiPilotReadinessCheck[]> { return [{ id: "pilot.external", category: "probe", status: "pass", message: "受控试点探针通过。", evidenceDigest: DIGEST }]; } }

function pilotDraft() { return { projectId: "project-a", name: "Pilot A", version: "1.0.0-pilot-rc", startsAt: "2026-07-01T00:00:00.000Z", endsAt: "2026-08-01T00:00:00.000Z", exitPolicyDigest: DIGEST }; }

describe("Pi M33 pilot control plane", () => {
  it("keeps default evidence and readiness fail-closed", async () => {
    const service = new PiPilotService(new InMemoryPiPilotStore(), new FailClosedPiPilotEvidenceVerifier(), new FailClosedPiPilotProbe());
    const owner = context();
    const pilot = await service.createPilot(owner, pilotDraft(), "m33-blocked");
    const journey = await service.recordJourney(owner, pilot.id, { kind: "new_feature", sampleDigest: DIGEST });
    expect(journey.status).toBe("pending");
    const readiness = await service.evaluateReadiness(owner, pilot.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.failureDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires all six verified journeys, observations, data sampling and a completed window", async () => {
    const service = new PiPilotService(new InMemoryPiPilotStore(), new PassingEvidence(), new PassingProbe());
    const owner = context();
    const pilot = await service.createPilot(owner, pilotDraft(), "m33-ready");
    const kinds = ["new_feature", "bug_fix", "refactor", "test_failure_repair", "code_review", "pull_request"] as const;
    for (const kind of kinds) for (let index = 0; index < 3; index += 1) await service.recordJourney(owner, pilot.id, { kind, sampleDigest: `${index + 1}`.repeat(64).slice(0, 64) });
    for (const metric of ["stability", "quality", "cost", "security", "adoption"] as const) await service.recordObservation(owner, pilot.id, { metric, windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-08-01T00:00:00.000Z", value: 1, threshold: 1, unit: "ratio" });
    await service.recordDataSample(owner, pilot.id, { classification: "internal", sampleDigest: DIGEST });
    const readiness = await service.evaluateReadiness(owner, pilot.id);
    expect(readiness.ready).toBe(true);
    expect(readiness.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("isolates tenants and exit revokes active participants without deleting facts", async () => {
    const service = new PiPilotService(new InMemoryPiPilotStore(), new PassingEvidence(), new PassingProbe());
    const owner = context();
    const other = context(TENANT_B, ACTOR_B);
    const pilot = await service.createPilot(owner, pilotDraft(), "m33-isolation");
    const participant = await service.addParticipant(owner, pilot.id, { subjectDigest: DIGEST, role: "engineer", projectScopeDigest: "c".repeat(64) });
    expect(await service.listPilots(other)).toHaveLength(0);
    await expect(service.exitPilot(other, pilot.id)).rejects.toThrow("PI_PILOT_NOT_FOUND");
    expect((await service.exitPilot(owner, pilot.id)).status).toBe("exited");
    expect((await service.snapshot(owner)).participants.find((item) => item.id === participant.id)?.status).toBe("revoked");
    await expect(service.recordJourney(owner, pilot.id, { kind: "bug_fix", sampleDigest: DIGEST })).rejects.toThrow("PI_PILOT_STATE_CONFLICT");
  });
});
