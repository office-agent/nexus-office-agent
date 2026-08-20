// Requirements: PR-005, PR-010, PR-011, AC-011, AC-012, AC-013, DR-011, DR-012
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getPilotOperations } from "@/app/api/v1/pi/admin/pilot-operations/route";
import { POST as createPilot } from "@/app/api/v1/pi/admin/pilots/route";
import { POST as recordJourney } from "@/app/api/v1/pi/admin/pilots/[pilotId]/journeys/route";
import { POST as evaluatePilotReadiness } from "@/app/api/v1/pi/admin/pilots/[pilotId]/readiness/route";
import { GET as getReleaseGovernance } from "@/app/api/v1/pi/admin/release-governance/route";
import { POST as createPublication } from "@/app/api/v1/pi/admin/publications/route";
import { POST as evaluateReleaseGate } from "@/app/api/v1/pi/admin/publications/[id]/gate-evaluation/route";

const DIGEST = "a".repeat(64);

function jsonRequest(url: string, method: string, body: unknown, key: string) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key, "x-trace-id": `api-m33-m34-${key}` },
    body: JSON.stringify(body),
  });
}

describe("Pi M33/M34 HTTP boundary", () => {
  it("creates fail-closed pilot and publication records and exposes safe operations snapshots", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const pilotResponse = await createPilot(jsonRequest("/api/v1/pi/admin/pilots", "POST", {
      projectId: "project-api",
      name: "API Pilot",
      version: "1.0.0-pilot-rc",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
      exitPolicyDigest: DIGEST,
    }, `m33-pilot-${suffix}`));
    expect(pilotResponse.status).toBe(201);
    const pilotBody = await pilotResponse.json();
    expect(pilotBody.data.status).toBe("active");
    expect(JSON.stringify(pilotBody)).not.toContain("tenantId");
    expect(JSON.stringify(pilotBody)).not.toContain("createdBy");

    const journeyResponse = await recordJourney(jsonRequest(`/api/v1/pi/admin/pilots/${pilotBody.data.id}/journeys`, "POST", { kind: "new_feature", sampleDigest: DIGEST }, `m33-journey-${suffix}`), { params: Promise.resolve({ pilotId: pilotBody.data.id }) });
    expect(journeyResponse.status).toBe(201);
    expect((await journeyResponse.json()).data.status).toBe("pending");
    const readinessResponse = await evaluatePilotReadiness(new Request("http://localhost", { method: "POST", headers: { "idempotency-key": `m33-readiness-${suffix}` } }), { params: Promise.resolve({ pilotId: pilotBody.data.id }) });
    expect(readinessResponse.status).toBe(201);
    expect((await readinessResponse.json()).data.ready).toBe(false);

    const publicationResponse = await createPublication(jsonRequest("/api/v1/pi/admin/publications", "POST", {
      version: "1.0.0",
      upstreamVersion: "0.1.0",
      apiDigest: DIGEST,
      schemaDigest: "b".repeat(64),
      imageDigest: "c".repeat(64),
      signatureDigest: "d".repeat(64),
      sbomDigest: "e".repeat(64),
      rollbackDigest: "f".repeat(64),
    }, `m34-publication-${suffix}`));
    expect(publicationResponse.status).toBe(201);
    const publicationBody = await publicationResponse.json();
    expect(publicationBody.data.status).toBe("candidate");
    expect(JSON.stringify(publicationBody)).not.toContain("tenantId");
    expect(JSON.stringify(publicationBody)).not.toContain("createdBy");

    const gateResponse = await evaluateReleaseGate(new Request("http://localhost", { method: "POST", headers: { "idempotency-key": `m34-gate-${suffix}` } }), { params: Promise.resolve({ id: publicationBody.data.id }) });
    expect(gateResponse.status).toBe(201);
    expect((await gateResponse.json()).data.ready).toBe(false);

    const pilotOperations = await getPilotOperations(new Request("http://localhost/api/v1/pi/admin/pilot-operations"));
    expect(pilotOperations.status).toBe(200);
    const pilotOperationsBody = await pilotOperations.json();
    expect(pilotOperationsBody.data.pilots.some((item: { id: string }) => item.id === pilotBody.data.id)).toBe(true);
    expect(JSON.stringify(pilotOperationsBody)).not.toContain("tenantId");

    const releaseGovernance = await getReleaseGovernance(new Request("http://localhost/api/v1/pi/admin/release-governance"));
    expect(releaseGovernance.status).toBe(200);
    const releaseGovernanceBody = await releaseGovernance.json();
    expect(releaseGovernanceBody.data.publications.some((item: { id: string }) => item.id === publicationBody.data.id)).toBe(true);
    expect(JSON.stringify(releaseGovernanceBody)).not.toContain("tenantId");
  });
});
