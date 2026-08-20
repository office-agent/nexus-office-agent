// Requirements: PR-002, PR-003, PR-006, MR-001, MR-002, MR-003, MR-004, MR-005, MR-006, MR-007, MR-010, MR-026, MR-027, MR-028, MR-029, MR-030
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { EnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/application/service";
import { InMemoryEnterpriseIntelligenceRepository, DEMO_DELIVERY_METRIC_ID, DEMO_REVIEW_ID, DEMO_TALENT_SUBJECT_ID } from "@/src/modules/enterprise-intelligence/infrastructure/in-memory-repository";
import { assertRaci, capacityStatus, type ResponsibilityAssignment } from "@/src/modules/organization/domain/management-governance";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";

function context(actorId: string, permissions: string[]): RequestContext {
  return { ...createDevelopmentRequestContext(), actorId, permissions, dataScopes: [{ type: "tenant" }] };
}

describe("enterprise intelligence governance", () => {
  it("keeps OKR and KPI semantics separate while tracing objectives to metrics and projects", async () => {
    const service = new EnterpriseIntelligenceService(new InMemoryEnterpriseIntelligenceRepository(), new InMemoryEventStore());
    const workspace = await service.workspace(createDevelopmentRequestContext());
    expect(workspace.objectives.map(({ objectiveType }) => objectiveType).sort()).toEqual(["kpi", "okr"]);
    for (const objective of workspace.objectives) {
      expect(objective.metricIds.length).toBeGreaterThan(0);
      expect(objective.projectIds.length).toBeGreaterThan(0);
      expect(objective.measurementMethod).not.toBe("");
      expect(objective.progress).not.toBeNull();
    }
  });

  it("records only evidenced metric facts and produces a read-only operating inference", async () => {
    const repository = new InMemoryEnterpriseIntelligenceRepository();
    const service = new EnterpriseIntelligenceService(repository, new InMemoryEventStore());
    const manager = createDevelopmentRequestContext();
    await expect(service.recordMetricObservation(manager, DEMO_DELIVERY_METRIC_ID, {
      value: 91, periodStart: "2026-08-04", periodEnd: "2026-08-10", observedAt: "2026-08-10T12:00:00.000Z",
      sourceType: "authoritative", sourceRef: "project-ledger:2026-W32", evidenceRefs: [],
    })).rejects.toThrow("METRIC_EVIDENCE_REQUIRED");
    const recorded = await service.recordMetricObservation(manager, DEMO_DELIVERY_METRIC_ID, {
      value: 91, periodStart: "2026-08-04", periodEnd: "2026-08-10", observedAt: "2026-08-10T12:00:00.000Z",
      sourceType: "authoritative", sourceRef: "project-ledger:2026-W32", evidenceRefs: ["acceptance-batch:2026-W32"],
    });
    expect(recorded.health).toBe("at_risk");
    const insight = await service.prepareOperatingInsight(manager);
    expect(insight.stateChanged).toBe(false);
    expect(insight.facts.some(({ statement }) => statement.includes("91"))).toBe(true);
    expect(insight.inferences.every(({ confidence, evidenceRefs }) => confidence > 0 && evidenceRefs.length > 0)).toBe(true);
    expect(insight.excludedDataScopes).toEqual(expect.arrayContaining(["one_to_one", "talent_label", "online_time"]));
  });

  it("requires the review owner and optimistic version to confirm an operating review", async () => {
    const service = new EnterpriseIntelligenceService(new InMemoryEnterpriseIntelligenceRepository(), new InMemoryEventStore());
    const outsider = context(DEMO_TALENT_SUBJECT_ID, ["operating_review:approve"]);
    await expect(service.confirmReview(outsider, DEMO_REVIEW_ID, 1)).rejects.toThrow("OPERATING_REVIEW_OWNER_REQUIRED");
    const confirmed = await service.confirmReview(createDevelopmentRequestContext(), DEMO_REVIEW_ID, 1);
    expect(confirmed).toMatchObject({ status: "confirmed", confirmedBy: DEMO_MANAGER_ID, version: 2 });
    await expect(service.confirmReview(createDevelopmentRequestContext(), DEMO_REVIEW_ID, 1)).rejects.toThrow("OPERATING_REVIEW_VERSION_CONFLICT");
  });

  it("enforces one accountable RACI owner and rejects monitoring-style capacity signals", () => {
    const base = { tenantId: DEMO_TENANT_ID, resourceType: "project" as const, resourceId: "30000000-0000-4000-8000-000000000001", subjectType: "user" as const, startsAt: "2026-08-01T00:00:00.000Z", version: 1 };
    const valid: ResponsibilityAssignment[] = [
      { ...base, id: crypto.randomUUID(), subjectId: DEMO_MANAGER_ID, role: "accountable" },
      { ...base, id: crypto.randomUUID(), subjectId: DEMO_TALENT_SUBJECT_ID, role: "responsible" },
    ];
    expect(() => assertRaci(valid)).not.toThrow();
    expect(() => assertRaci([...valid, { ...valid[0], id: crypto.randomUUID(), subjectId: "10000000-0000-4000-8000-000000000003" }])).toThrow("RACI_SINGLE_ACCOUNTABLE_REQUIRED");
    expect(() => capacityStatus({
      id: crypto.randomUUID(), tenantId: DEMO_TENANT_ID, userId: DEMO_TALENT_SUBJECT_ID, periodStart: "2026-08-03", periodEnd: "2026-08-09",
      availableHours: 40, allocations: [{ resourceType: "project", resourceId: base.resourceId, allocationPercent: 80 }], includedSignals: ["online_time"], version: 1,
    })).toThrow("MONITORING_SIGNAL_PROHIBITED");
  });

  it("builds a talent evidence pack without scores, rankings, employment decisions, or private 1:1 content", async () => {
    const service = new EnterpriseIntelligenceService(new InMemoryEnterpriseIntelligenceRepository(), new InMemoryEventStore());
    const pack = await service.prepareTalentEvidence(createDevelopmentRequestContext(), DEMO_TALENT_SUBJECT_ID, "development_conversation");
    expect(pack.evidence).toHaveLength(1);
    expect(pack.usedDataScopes).toEqual(expect.arrayContaining(["project", "development_goal"]));
    expect(pack.excludedDataScopes).toEqual(expect.arrayContaining(["one_to_one", "talent_label", "private_chat_frequency"]));
    expect(pack).toMatchObject({ stateChanged: false, score: null, rank: null, employmentRecommendation: null });
    expect(JSON.stringify(pack)).not.toContain("受限的 1:1 私密记录");
    const unrelatedManager = context("10000000-0000-4000-8000-000000000099", ["talent_evidence:read"]);
    const restricted = await service.prepareTalentEvidence(unrelatedManager, DEMO_TALENT_SUBJECT_ID, "development_conversation");
    expect(restricted.evidence).toHaveLength(0);
    expect(restricted.usedDataScopes).not.toContain("development_goal");
  });
});
