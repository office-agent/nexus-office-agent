// Requirements: PR-001, PR-003, PR-008, MR-006, MR-009, MR-011, MR-013, MR-014, MR-015, MR-017, AR-002, AR-003, SR-001, SR-004
import { describe, expect, it } from "vitest";
import { EnterpriseGovernanceService } from "@/src/modules/enterprise-governance/application/service";
import { InMemoryEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/in-memory-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import {
  createDevelopmentRequestContext,
  DEMO_MANAGER_ID,
  DEMO_PROJECT_ID,
} from "@/src/platform/context/development-context";

const SUCCESSOR_ID = "10000000-0000-4000-8000-000000000002";
const APPROVER_ID = "10000000-0000-4000-8000-000000000003";

function fixture() {
  const repository = new InMemoryEnterpriseGovernanceRepository();
  const events = new InMemoryEventStore();
  const service = new EnterpriseGovernanceService(repository, events);
  const requester = createDevelopmentRequestContext("governance-request");
  const approver = { ...createDevelopmentRequestContext("governance-approve"), actorId: APPROVER_ID };
  return { repository, events, service, requester, approver };
}

describe("enterprise governance", () => {
  it("creates a traceable objective and compliant project baseline as one initiative", async () => {
    const { repository, service, requester } = fixture();
    const input = {
      objective: { title: "续约率达到 94%", description: "通过稳定交付提升核心客户续约", ownerId: DEMO_MANAGER_ID, baseline: 88, targetValue: 94, currentValue: 89, unit: "%", startsAt: "2026-08-01", endsAt: "2026-12-31", reviewCadence: "monthly" as const },
      project: { code: "RENEWAL-2026", name: "核心客户续约提升", description: "建立客户健康与交付联动机制", ownerId: DEMO_MANAGER_ID, businessValue: "降低客户流失并提升年度经常性收入", acceptanceCriteria: "核心客户续约率达到 94% 且完成复盘", resourcePlan: { customerSuccess: 2, delivery: 2 }, priority: "high" as const, startsAt: "2026-08-10", targetEndAt: "2026-12-20", budget: 300000, currency: "CNY" },
    };
    const created = await service.createInitiative(requester, input);
    expect(created).toMatchObject({ objective: { status: "proposed", version: 1 }, project: { code: "RENEWAL-2026", status: "proposed", baselineVersion: 1, projectVersion: 1 } });
    expect((await repository.getWorkspace(requester.tenantId)).objectives.some(({ id }) => id === created.objective.id)).toBe(true);
    await expect(service.createInitiative(requester, input)).rejects.toThrow("PROJECT_CODE_CONFLICT");
  });

  it("enforces separation of duties and transfers every open ownership before departure", async () => {
    const { repository, service, requester, approver } = fixture();
    const change = await service.createOrganizationChange(requester, {
      subjectUserId: DEMO_MANAGER_ID,
      changeType: "departure",
      effectiveAt: "2026-08-05T00:00:00.000Z",
      successorUserId: SUCCESSOR_ID,
      reason: "岗位调整并完成工作交接",
    });

    await expect(service.approveOrganizationChange(requester, change.id, change.version)).rejects.toThrow("SEPARATION_OF_DUTIES_REQUIRED");
    const approved = await service.approveOrganizationChange(approver, change.id, change.version);
    const result = await service.executeOrganizationChange(approver, change.id, approved.version, new Date("2026-08-06T00:00:00.000Z"));

    expect(result.change.status).toBe("completed");
    expect(result.handoffs).toMatchObject([{ resourceType: "task", fromUserId: DEMO_MANAGER_ID, toUserId: SUCCESSOR_ID, status: "transferred" }]);
    expect(repository.pendingOwnerships[0]?.fromUserId).toBe(SUCCESSOR_ID);
  });

  it("blocks execution before the effective time without mutating the approved change", async () => {
    const { repository, service, requester, approver } = fixture();
    const change = await service.createOrganizationChange(requester, {
      subjectUserId: DEMO_MANAGER_ID,
      changeType: "departure",
      effectiveAt: "2026-08-06T00:00:00.000Z",
      successorUserId: SUCCESSOR_ID,
      reason: "按未来生效日完成离职交接",
    });
    const approved = await service.approveOrganizationChange(approver, change.id, change.version);

    await expect(service.executeOrganizationChange(approver, change.id, approved.version, new Date("2026-08-05T23:59:59.000Z"))).rejects.toThrow("ORGANIZATION_CHANGE_NOT_EFFECTIVE");
    await expect(repository.getOrganizationChange(requester.tenantId, change.id)).resolves.toMatchObject({ status: "approved", version: approved.version });
  });

  it("fails closed when a departing owner has work but no successor", async () => {
    const { service, requester, approver } = fixture();
    const change = await service.createOrganizationChange(requester, {
      subjectUserId: DEMO_MANAGER_ID,
      changeType: "departure",
      effectiveAt: "2026-08-05T00:00:00.000Z",
      reason: "离职交接",
    });
    const approved = await service.approveOrganizationChange(approver, change.id, change.version);
    await expect(service.executeOrganizationChange(approver, change.id, approved.version, new Date("2026-08-06T00:00:00.000Z"))).rejects.toThrow("ORGANIZATION_CHANGE_SUCCESSOR_REQUIRED");
  });

  it("applies an approved baseline change and restores it through a version-bound compensation", async () => {
    const { repository, service, requester, approver } = fixture();
    const before = await repository.getProject(requester.tenantId, DEMO_PROJECT_ID);
    const change = await service.createProjectChange(requester, {
      projectId: DEMO_PROJECT_ID,
      changeType: "schedule",
      proposedBaseline: { targetEndAt: "2026-10-15", resourcePlan: { delivery: 4, qa: 2 } },
      reason: "客户验收窗口调整",
      impactAssessment: "延期两周，增加一名交付与一名质量人员",
    });
    await expect(service.approveProjectChange(requester, change.id, change.version)).rejects.toThrow("SEPARATION_OF_DUTIES_REQUIRED");
    const approved = await service.approveProjectChange(approver, change.id, change.version);
    const applied = await service.applyProjectChange(approver, change.id, approved.version, new Date("2026-08-06T00:00:00.000Z"));

    expect(await repository.getProject(requester.tenantId, DEMO_PROJECT_ID)).toMatchObject({ targetEndAt: "2026-10-15", baselineVersion: 2, projectVersion: 4 });
    await service.executeCompensation(approver, applied.compensation.id, applied.compensation.version, new Date("2026-08-07T00:00:00.000Z"));
    const restored = await repository.getProject(requester.tenantId, DEMO_PROJECT_ID);
    expect(restored).toMatchObject({ targetEndAt: before?.targetEndAt, status: "active", baselineVersion: 3, projectVersion: 5 });
    expect((await repository.getProjectChange(requester.tenantId, change.id))?.status).toBe("compensated");
  });

  it("requires acceptance evidence, named handoffs, closing state and a distinct approver", async () => {
    const { repository, service, requester, approver } = fixture();
    await expect(service.saveClosureReview(requester, DEMO_PROJECT_ID, {
      deliveryAcceptanceRef: "",
      retrospectiveRef: "knowledge://retrospectives/east-delivery",
      unresolvedItems: [],
    })).rejects.toThrow("PROJECT_DELIVERY_ACCEPTANCE_REQUIRED");

    const review = await service.saveClosureReview(requester, DEMO_PROJECT_ID, {
      deliveryAcceptanceRef: "document://acceptance/customer-signoff",
      retrospectiveRef: "knowledge://retrospectives/east-delivery",
      unresolvedItems: [{ resourceType: "risk", resourceId: "risk-open-1", handoffOwnerId: SUCCESSOR_ID, evidenceRef: "document://handoffs/risk-open-1" }],
    });
    await expect(service.approveAndCompleteProject(requester, DEMO_PROJECT_ID, review.version, 3)).rejects.toThrow("SEPARATION_OF_DUTIES_REQUIRED");
    await expect(service.approveAndCompleteProject(approver, DEMO_PROJECT_ID, review.version, 3)).rejects.toThrow("PROJECT_VERSION_CONFLICT");
    expect(await repository.getClosureReview(requester.tenantId, DEMO_PROJECT_ID)).toMatchObject({ status: "ready", version: review.version });
    repository.projects.set(DEMO_PROJECT_ID, { ...(await repository.getProject(requester.tenantId, DEMO_PROJECT_ID))!, status: "closing" });
    const completed = await service.approveAndCompleteProject(approver, DEMO_PROJECT_ID, review.version, 3);
    expect(completed.status).toBe("completed");
    expect(await repository.getProject(requester.tenantId, DEMO_PROJECT_ID)).toMatchObject({ status: "completed", projectVersion: 4 });
  });

  it("deduplicates repeated management-attention scans", async () => {
    const { repository, service, requester } = fixture();
    await service.scanAttention(requester, new Date("2026-08-06T00:00:00.000Z"));
    await service.scanAttention(requester, new Date("2026-08-07T00:00:00.000Z"));
    expect(repository.attentionItems).toHaveLength(1);
    expect(repository.attentionItems[0]).toMatchObject({ reasonCode: "risk_exposure", severity: "at_risk", version: 2 });
  });
});
