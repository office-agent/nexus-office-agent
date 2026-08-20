// Requirements: PR-001, PR-003, PR-008, MR-006, MR-009, MR-011, MR-013, MR-014, AR-002, AR-003, SR-001
import { describe, expect, it } from "vitest";
import { GET as getWorkspace } from "@/app/api/v1/enterprise-governance/workspace/route";
import { POST as createOrganizationChange } from "@/app/api/v1/enterprise-governance/organization-changes/route";
import { POST as createProjectChange } from "@/app/api/v1/enterprise-governance/project-changes/route";
import { POST as scanAttention } from "@/app/api/v1/enterprise-governance/attention/scan/route";
import { POST as createInitiative } from "@/app/api/v1/enterprise-governance/initiatives/route";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trace-id": "governance-api-test" },
    body: JSON.stringify(body),
  });
}

describe("enterprise governance API", () => {
  it("atomically proposes an objective-linked project with every mandatory initiation field", async () => {
    const code = `API-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const response = await createInitiative(post("/api/v1/enterprise-governance/initiatives", {
      objective: { title: "项目交付准时率达到 96%", description: "以标准计划和例外管理提升准时率", ownerId: DEMO_MANAGER_ID, baseline: 89, targetValue: 96, currentValue: 90, unit: "%", startsAt: "2026-08-01", endsAt: "2026-12-31", reviewCadence: "monthly" },
      project: { code, name: "交付标准化二期", description: "统一关键项目交付方法", ownerId: DEMO_MANAGER_ID, businessValue: "减少延期并提升客户续约", acceptanceCriteria: "准时率达到 96% 并完成项目复盘", resourcePlan: { delivery: 3, qa: 1 }, priority: "high", startsAt: "2026-08-10", targetEndAt: "2026-12-20", budget: 500000, currency: "CNY" },
    }));
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({ objective: { status: "proposed" }, project: { code, status: "proposed", businessValue: "减少延期并提升客户续约" } });
    const workspace = (await (await getWorkspace(new Request("http://localhost/api/v1/enterprise-governance/workspace"))).json()).data;
    expect(workspace.objectives.some((item: { id: string }) => item.id === payload.data.objective.id)).toBe(true);
    expect(workspace.projects.some((item: { id: string }) => item.id === payload.data.project.id)).toBe(true);
  });

  it("creates governed organization and project changes and exposes them in one workspace", async () => {
    const organizationResponse = await createOrganizationChange(post("/api/v1/enterprise-governance/organization-changes", {
      subjectUserId: DEMO_MANAGER_ID,
      changeType: "departure",
      effectiveAt: "2026-08-05T00:00:00.000Z",
      successorUserId: "10000000-0000-4000-8000-000000000002",
      reason: "API 验证离职交接",
    }));
    expect(organizationResponse.status).toBe(201);
    const organization = (await organizationResponse.json()).data;
    expect(organization).toMatchObject({ status: "submitted", requestedBy: DEMO_MANAGER_ID, version: 1 });

    const projectResponse = await createProjectChange(post("/api/v1/enterprise-governance/project-changes", {
      projectId: DEMO_PROJECT_ID,
      changeType: "schedule",
      proposedBaseline: { targetEndAt: "2026-10-15" },
      reason: "API 验证基线变更",
      impactAssessment: "延期两周并重新确认资源承诺",
    }));
    expect(projectResponse.status).toBe(201);
    const projectChange = (await projectResponse.json()).data;
    expect(projectChange).toMatchObject({ projectId: DEMO_PROJECT_ID, status: "submitted", baselineBefore: { baselineVersion: 1, projectVersion: 3 } });

    const workspaceResponse = await getWorkspace(new Request("http://localhost/api/v1/enterprise-governance/workspace", { headers: { "x-trace-id": "governance-api-test" } }));
    expect(workspaceResponse.status).toBe(200);
    const workspace = (await workspaceResponse.json()).data;
    expect(workspace.organizationChanges.some((item: { id: string }) => item.id === organization.id)).toBe(true);
    expect(workspace.projectChanges.some((item: { id: string }) => item.id === projectChange.id)).toBe(true);
  });

  it("deduplicates attention scans and rejects self-asserted or incomplete governance input", async () => {
    const first = await scanAttention(post("/api/v1/enterprise-governance/attention/scan", { now: "2026-08-06T00:00:00.000Z" }));
    const second = await scanAttention(post("/api/v1/enterprise-governance/attention/scan", { now: "2026-08-07T00:00:00.000Z" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const workspace = (await (await getWorkspace(new Request("http://localhost/api/v1/enterprise-governance/workspace"))).json()).data;
    expect(workspace.attentionItems.filter((item: { reasonCode: string }) => item.reasonCode === "risk_exposure")).toHaveLength(1);

    const invalid = await createOrganizationChange(post("/api/v1/enterprise-governance/organization-changes", {
      subjectUserId: DEMO_MANAGER_ID,
      tenantId: "attacker-tenant",
      requestedBy: "attacker-user",
      changeType: "transfer",
      effectiveAt: "2026-08-05T00:00:00.000Z",
      reason: "缺少目标组织",
    }));
    expect(invalid.status).toBe(422);
  });
});
