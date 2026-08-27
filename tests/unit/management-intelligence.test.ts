// Requirements: MR-031, MR-032, MR-033, MR-034, MR-035, MR-036, MR-037, MR-038, MR-039, MR-040, MR-041, MR-043, MR-044, AC-011
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { ManagementIntelligenceService } from "@/src/modules/management-intelligence/application/service";
import {
  DEMO_CADENCE_OCCURRENCE_ID,
  DEMO_ENTERPRISE_CASE_ID,
  DEMO_METRIC_ID,
  DEMO_PORTFOLIO_ID,
  DEMO_PORTFOLIO_SCENARIO_ID,
  DEMO_WECOM_CONNECTION_ID,
  InMemoryManagementIntelligenceRepository,
  InMemoryManagementWecomGateway,
} from "@/src/modules/management-intelligence/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

const now = new Date("2026-08-05T01:00:00.000Z");

function fixture() {
  const repository = new InMemoryManagementIntelligenceRepository();
  const events = new InMemoryEventStore();
  const wecom = new InMemoryManagementWecomGateway();
  const model = new FakeModelGateway(JSON.stringify({
    inferences: [{ statement: "关键事项需要在会议中明确责任边界。", confidence: 0.82, evidenceRefs: [`enterprise-case:${DEMO_ENTERPRISE_CASE_ID}:v1`, "forged:evidence"] }],
    proposals: ["由会议 Owner 确认跨团队责任与期限。"],
  }));
  const service = new ManagementIntelligenceService(repository, events, model, wecom, { dataMode: "development_fixture", appBaseUrl: "https://office.example", now: () => now });
  return { repository, events, wecom, service, context: createDevelopmentRequestContext("management-test") };
}

describe("management intelligence", () => {
  it("prepares a cited read-only cadence briefing and requires closure evidence", async () => {
    const { service, context } = fixture();
    const ready = await service.prepareOccurrence(context, DEMO_CADENCE_OCCURRENCE_ID);
    expect(ready).toMatchObject({ status: "ready", version: 3, briefing: { stateChanged: false, degraded: false } });
    expect(ready.briefing?.inferences[0].evidenceRefs).toEqual([`enterprise-case:${DEMO_ENTERPRISE_CASE_ID}:v1`]);
    expect(ready.briefing?.excludedDataScopes).toEqual(expect.arrayContaining(["private_chat", "one_to_one", "credential"]));
    const scenarioFact = ready.briefing?.facts.find(({ evidenceRefs }) => evidenceRefs.includes(`portfolio-scenario:${DEMO_PORTFOLIO_SCENARIO_ID}:v1`));
    expect(scenarioFact?.statement).toContain("本月总交付容量保持不变");
    expect(scenarioFact?.statement).toContain(DEMO_PORTFOLIO_ID);
    expect(scenarioFact?.statement).toContain(DEMO_PROJECT_ID);
    expect(scenarioFact?.statement).toContain("容量 65%");
    const running = await service.transitionOccurrence(context, ready.id, { targetStatus: "in_progress", version: ready.version, evidenceRefs: [] });
    const awaiting = await service.transitionOccurrence(context, running.id, { targetStatus: "awaiting_evidence", version: running.version, evidenceRefs: [] });
    await expect(service.transitionOccurrence(context, awaiting.id, { targetStatus: "closed", version: awaiting.version, evidenceRefs: [] })).rejects.toThrow("CADENCE_OUTCOME_EVIDENCE_REQUIRED");
    await expect(service.transitionOccurrence(context, awaiting.id, { targetStatus: "closed", version: awaiting.version, evidenceRefs: ["minutes:weekly-ops:2026-W32"] })).resolves.toMatchObject({ status: "closed", outcomeEvidenceRefs: ["minutes:weekly-ops:2026-W32"] });
  });

  it("versions metric semantics and never presents missing, stale, or unverified data as healthy", async () => {
    const { service, context } = fixture();
    const workspace = await service.workspace(context);
    const current = workspace.metricProfiles[0];
    expect(current).toMatchObject({ metricId: DEMO_METRIC_ID, businessDefinition: expect.any(String), authoritativeSource: expect.any(String), prohibitedUses: expect.arrayContaining(["个人绩效自动评分"]) });
    const updated = await service.upsertMetricProfile(context, DEMO_METRIC_ID, {
      businessDefinition: current.businessDefinition, formula: current.formula, ownerId: current.ownerId, stewardId: current.stewardId,
      authoritativeSource: "项目验收权威台账", sourceLocator: current.sourceLocator, refreshCadence: current.refreshCadence, freshnessSlaMinutes: 60,
      dimensions: current.dimensions, allowedUses: current.allowedUses, prohibitedUses: current.prohibitedUses, version: current.version,
    });
    expect(updated).toMatchObject({ version: 2, freshnessSlaMinutes: 60 });
    await expect(service.upsertMetricProfile(context, DEMO_METRIC_ID, { ...updated, version: 1 })).rejects.toThrow("METRIC_SEMANTIC_PROFILE_VERSION_CONFLICT");
    await expect(service.checkMetricQuality(context, DEMO_METRIC_ID, { completenessPercent: 100, evidenceRefs: [] })).resolves.toMatchObject({ status: "missing" });
    await expect(service.checkMetricQuality(context, DEMO_METRIC_ID, { observedAt: "2026-08-05T02:00:00.000Z", completenessPercent: 100, evidenceRefs: ["ledger:future"] })).resolves.toMatchObject({ status: "unverified" });
    await expect(service.checkMetricQuality(context, DEMO_METRIC_ID, { observedAt: "2026-08-04T00:00:00.000Z", completenessPercent: 100, evidenceRefs: ["ledger:old"] })).resolves.toMatchObject({ status: "stale" });
    await expect(service.checkMetricQuality(context, DEMO_METRIC_ID, { observedAt: "2026-08-05T00:30:00.000Z", completenessPercent: 100, evidenceRefs: ["ledger:fresh"] })).resolves.toMatchObject({ status: "healthy" });
  });

  it("compares evidence-bound portfolio scenarios and keeps exactly one selected history", async () => {
    const { service, repository, context } = fixture();
    await expect(service.createScenario(context, DEMO_PORTFOLIO_ID, {
      name: "范围外项目", assumptions: ["不得把未纳入组合的项目带入情景"], projectDecisions: [{ projectId: "30000000-0000-4000-8000-000000000099", action: "pause", capacityPercent: 20, rationale: "该项目不在当前组合范围内。" }],
      expectedBenefit: 0, estimatedCost: 0, riskScore: 10, evidenceRefs: ["scope-check:out-of-portfolio"], status: "draft",
    })).rejects.toThrow("PORTFOLIO_SCENARIO_SCOPE_INVALID");
    const first = await service.selectScenario(context, DEMO_PORTFOLIO_SCENARIO_ID, 1);
    expect(first).toMatchObject({ status: "selected", selectedBy: context.actorId });
    const alternative = await service.createScenario(context, DEMO_PORTFOLIO_ID, {
      name: "控制风险并分阶段交付", assumptions: ["核心验收容量不下降"], projectDecisions: [{ projectId: DEMO_PROJECT_ID, action: "continue", capacityPercent: 45, rationale: "保留风险缓冲" }],
      expectedBenefit: 95, estimatedCost: 24, riskScore: 5, evidenceRefs: ["capacity-plan:2026-W32"], status: "recommended",
    });
    await service.selectScenario(context, alternative.id, alternative.version);
    const scenarios = (await repository.getData(context.tenantId)).scenarios;
    expect(scenarios.filter(({ status }) => status === "selected")).toHaveLength(1);
    expect(scenarios.find(({ id }) => id === first.id)?.status).toBe("superseded");
    expect(scenarios.find(({ id }) => id === alternative.id)).toMatchObject({ status: "selected", assumptions: ["核心验收容量不下降"], evidenceRefs: ["capacity-plan:2026-W32"] });
  });

  it("runs a coded enterprise case through owner SLA and evidence gates", async () => {
    const { service, context } = fixture();
    const item = await service.createCase(context, { caseType: "quality", title: "验收回归证据缺失", description: "发布候选缺少完整回归证据。", severity: "high", ownerId: context.actorId, dueAt: "2026-08-06T01:00:00.000Z", slaMinutes: 1_440, sourceType: "web", sourceRef: "release:0.13.0", relatedObjectRefs: ["project:release"], evidenceRefs: [] });
    expect(item).toMatchObject({ code: expect.stringMatching(/^CASE-20260805-/), status: "open", ownerId: context.actorId, slaMinutes: 1_440 });
    const running = await service.transitionCase(context, item.id, { targetStatus: "in_progress", version: item.version, ownerId: context.actorId, evidenceRefs: [] });
    await expect(service.transitionCase(context, running.id, { targetStatus: "resolved", version: running.version, evidenceRefs: [] })).rejects.toThrow("ENTERPRISE_CASE_EVIDENCE_REQUIRED");
    const resolved = await service.transitionCase(context, running.id, { targetStatus: "resolved", version: running.version, evidenceRefs: ["test-run:regression-32"] });
    await expect(service.transitionCase(context, resolved.id, { targetStatus: "closed", version: resolved.version, evidenceRefs: [] })).resolves.toMatchObject({ status: "closed", evidenceRefs: ["test-run:regression-32"] });
  });

  it("withholds AI pass rates for small samples and preserves unknown outcomes", async () => {
    const { service, context } = fixture();
    expect(await service.aiScorecard(context)).toMatchObject({ status: "insufficient_data", sampleSize: 0, passRate: null });
    const record = (index: number, outcome: "passed" | "failed" | "unknown") => service.recordAiEvaluation(context, {
      capabilityId: "management.briefing", provider: "test-provider", model: "eval-model", promptVersion: `p${index}`, datasetRef: "evalset:management-v1", outcome,
      scores: { groundedness: .95, citationCorrectness: .94, policyCorrectness: .96, taskCompletion: .9 }, inputTokens: 100, outputTokens: 50, latencyMs: 100 + index, costMicrounits: 12,
      evidenceRefs: [`eval-run:${index}`], evaluatedAt: `2026-08-05T00:0${index}:00.000Z`,
    });
    await record(1, "passed"); await record(2, "passed");
    expect(await service.aiScorecard(context)).toMatchObject({ status: "insufficient_data", sampleSize: 2, passRate: null });
    await record(3, "unknown");
    const scorecard = await service.aiScorecard(context);
    expect(scorecard).toMatchObject({ sampleSize: 3, unknownCount: 1, passRate: 2 / 3, status: "at_risk" });
    expect(JSON.stringify((await service.workspace(context)).recentEvaluations)).not.toContain("rawPrompt");
  });

  it("persists only the recipient digest and executes a WeCom action once", async () => {
    const { service, repository, wecom, context } = fixture();
    const recipient = "wecom-user-42";
    const dispatched = await service.dispatchWecomAction(context, { actionType: "case_accept", resourceId: DEMO_ENTERPRISE_CASE_ID, connectionId: DEMO_WECOM_CONNECTION_ID, externalUserId: recipient, expiresInMinutes: 10 });
    expect(dispatched.delivery.status).toBe("delivered");
    expect(wecom.deliveries).toHaveLength(1);
    const persisted = (await repository.getData(context.tenantId)).channelActions[0];
    expect(persisted.recipientDigest).toBe(createHash("sha256").update(recipient).digest("hex"));
    expect(JSON.stringify(persisted)).not.toContain(recipient);
    const wecomContext = { ...context, channel: "wecom" as const, sessionId: "wecom:verified" };
    await expect(service.confirmChannelAction(wecomContext, persisted.id, persisted.proposalHash, createHash("sha256").update("another-user").digest("hex"))).rejects.toThrow("MANAGEMENT_CHANNEL_RECIPIENT_MISMATCH");
    const executed = await service.confirmChannelAction(wecomContext, persisted.id, persisted.proposalHash, persisted.recipientDigest);
    expect(executed).toMatchObject({ status: "executed", version: 2, executedBy: context.actorId });
    await expect(service.confirmChannelAction(wecomContext, persisted.id, persisted.proposalHash, persisted.recipientDigest)).resolves.toEqual(executed);
    expect(await repository.getCase(context.tenantId, DEMO_ENTERPRISE_CASE_ID)).toMatchObject({ status: "in_progress", ownerId: context.actorId, version: 2 });
  });
});
