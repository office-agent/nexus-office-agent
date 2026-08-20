// Requirements: PR-002, PR-006, MR-001, MR-002, MR-003, MR-004, MR-005, MR-010, MR-026, MR-027, MR-028, MR-029, MR-030, AC-007
import { describe, expect, it } from "vitest";
import { GET as getWorkspace } from "@/app/api/v1/enterprise-intelligence/workspace/route";
import { POST as prepareInsight } from "@/app/api/v1/enterprise-intelligence/insights/prepare/route";
import { POST as prepareTalentEvidence } from "@/app/api/v1/enterprise-intelligence/talent/evidence/route";
import { POST as recordMetric } from "@/app/api/v1/enterprise-intelligence/metrics/[id]/observations/route";
import { DEMO_DELIVERY_METRIC_ID, DEMO_TALENT_SUBJECT_ID } from "@/src/modules/enterprise-intelligence/infrastructure/in-memory-repository";

function post(url: string, body?: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": "enterprise-api-test" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("enterprise intelligence HTTP API", () => {
  it("returns traceable management facts and read-only AI preparation results", async () => {
    const workspaceResponse = await getWorkspace(new Request("http://localhost/api/v1/enterprise-intelligence/workspace"));
    const workspace = await workspaceResponse.json();
    expect(workspaceResponse.status).toBe(200);
    expect(workspace.data.objectives.map((item: { objectiveType: string }) => item.objectiveType).sort()).toEqual(["kpi", "okr"]);
    expect(workspace.data.metrics[0].latestObservation.sourceRef).toBeTruthy();

    const insightResponse = await prepareInsight(post("http://localhost/api/v1/enterprise-intelligence/insights/prepare"));
    const insight = await insightResponse.json();
    expect(insightResponse.status).toBe(200);
    expect(insight.data).toMatchObject({ stateChanged: false });
    expect(insight.data.excludedDataScopes).toContain("one_to_one");

    const talentResponse = await prepareTalentEvidence(post("http://localhost/api/v1/enterprise-intelligence/talent/evidence", { subjectUserId: DEMO_TALENT_SUBJECT_ID, purpose: "development_conversation" }));
    const talent = await talentResponse.json();
    expect(talentResponse.status).toBe(200);
    expect(talent.data).toMatchObject({ stateChanged: false, score: null, rank: null, employmentRecommendation: null });
    expect(JSON.stringify(talent.data)).not.toContain("受限的 1:1 私密记录");
  });

  it("rejects an unevidenced metric observation at the API boundary", async () => {
    const response = await recordMetric(post(`http://localhost/api/v1/enterprise-intelligence/metrics/${DEMO_DELIVERY_METRIC_ID}/observations`, {
      value: 90, periodStart: "2026-08-04", periodEnd: "2026-08-10", observedAt: "2026-08-10T00:00:00.000Z",
      sourceType: "authoritative", sourceRef: "ledger:W32", evidenceRefs: [],
    }), { params: Promise.resolve({ id: DEMO_DELIVERY_METRIC_ID }) });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
