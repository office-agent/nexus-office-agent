// Requirements: PR-001, PR-003, MR-006, MR-012, MR-022, MR-023, MR-024, AC-002
import { describe, expect, it } from "vitest";
import { GET as getSnapshot } from "@/app/api/v1/management/snapshot/route";
import { POST as createRisk } from "@/app/api/v1/management/risks/route";
import { POST as createDecision } from "@/app/api/v1/management/decisions/route";
import { POST as supersedeDecision } from "@/app/api/v1/management/decisions/[id]/supersede/route";
import { POST as completeAction } from "@/app/api/v1/management/action-items/[id]/complete/route";
import { POST as transitionTask } from "@/app/api/v1/management/tasks/[id]/transition/route";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trace-id": "api-integration-test" },
    body: JSON.stringify(body),
  });
}

describe("management HTTP API", () => {
  it("returns the management snapshot envelope", async () => {
    const response = await getSnapshot(new Request(`http://localhost/api/v1/management/snapshot?projectId=${DEMO_PROJECT_ID}`));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.project.id).toBe(DEMO_PROJECT_ID);
    expect(payload.data.objective.title).toContain("按期交付率");
    expect(payload.data.milestones).toHaveLength(1);
    expect(payload.data.tasks).toHaveLength(3);
    expect(payload.meta.traceId).toBeTruthy();
  });

  it("requires an explicit project instead of falling back to a development fixture", async () => {
    const response = await getSnapshot(new Request("http://localhost/api/v1/management/snapshot"));
    const payload = await response.json();
    expect(response.status).toBe(422);
    expect(payload.error.code).toBe("VALIDATION_FAILED");
  });

  it("advances a delivery task through the HTTP state boundary", async () => {
    const taskId = "70000000-0000-4000-8000-000000000002";
    const response = await transitionTask(
      jsonRequest(`http://localhost/api/v1/management/tasks/${taskId}/transition`, { status: "completed" }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.status).toBe("completed");
    expect(payload.data.completedAt).toBeTruthy();
  });

  it("rejects malformed risk input without exposing internals", async () => {
    const response = await createRisk(jsonRequest("http://localhost/api/v1/management/risks", { title: "x" }));
    const payload = await response.json();
    expect(response.status).toBe(422);
    expect(payload.error.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(payload)).not.toContain("stack");
  });

  it("creates a risk, a decision and a verifiable action", async () => {
    const riskResponse = await createRisk(
      jsonRequest("http://localhost/api/v1/management/risks", {
        projectId: DEMO_PROJECT_ID,
        title: "客户验收人员时间冲突",
        description: "原定验收人无法参加周五验收。",
        ownerId: DEMO_MANAGER_ID,
        probability: 3,
        impact: 4,
        sourceType: "human",
      }),
    );
    const riskPayload = await riskResponse.json();
    expect(riskResponse.status).toBe(201);

    const decisionResponse = await createDecision(
      jsonRequest("http://localhost/api/v1/management/decisions", {
        projectId: DEMO_PROJECT_ID,
        riskId: riskPayload.data.id,
        title: "启用客户侧代理验收人",
        decisionContext: "原验收人时间冲突，但上线窗口不可移动。",
        options: ["代理验收", "延期验收"],
        selectedOption: "代理验收",
        rationale: "代理人具备授权且可保持上线节奏。",
        actionItems: [
          {
            title: "取得代理验收授权书",
            ownerId: DEMO_MANAGER_ID,
            dueAt: "2026-08-06T03:00:00.000Z",
            acceptanceCriteria: "授权书完成双方签署",
          },
        ],
      }),
    );
    const decisionPayload = await decisionResponse.json();
    expect(decisionResponse.status).toBe(201);
    expect(decisionPayload.data.decision.status).toBe("decided");

    const actionId = decisionPayload.data.actionItems[0].id;
    const completionResponse = await completeAction(
      jsonRequest(`http://localhost/api/v1/management/action-items/${actionId}/complete`, {
        evidence: "授权书 AUTH-2026-102 双方已签署",
      }),
      { params: Promise.resolve({ id: actionId }) },
    );
    const completionPayload = await completionResponse.json();
    expect(completionResponse.status).toBe(200);
    expect(completionPayload.data.status).toBe("completed");
    expect(completionPayload.data.completionEvidence).toContain("AUTH-2026-102");
  });

  it("supersedes a formal decision without overwriting its history", async () => {
    const createdResponse = await createDecision(jsonRequest("http://localhost/api/v1/management/decisions", {
      projectId: DEMO_PROJECT_ID, title: "采用一次性发布", decisionContext: "原风险可控",
      options: ["一次性发布", "分批发布"], selectedOption: "一次性发布", rationale: "减少协调成本",
      actionItems: [{ title: "准备发布清单", ownerId: DEMO_MANAGER_ID, dueAt: "2026-08-08T00:00:00.000Z", acceptanceCriteria: "清单完成" }],
    }));
    const created = (await createdResponse.json()).data.decision;
    const response = await supersedeDecision(
      jsonRequest(`http://localhost/api/v1/management/decisions/${created.id}/supersede`, {
        version: created.version, title: "调整为分批发布", decisionContext: "出现新的客户影响证据",
        options: ["一次性发布", "分批发布"], selectedOption: "分批发布", rationale: "限制故障面",
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.original).toMatchObject({ id: created.id, status: "superseded" });
    expect(payload.data.replacement).toMatchObject({ status: "decided", supersedesId: created.id });
    const snapshotResponse = await getSnapshot(new Request(`http://localhost/api/v1/management/snapshot?projectId=${DEMO_PROJECT_ID}`));
    const snapshot = (await snapshotResponse.json()).data;
    expect(snapshot.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, status: "superseded" }),
      expect.objectContaining({ id: payload.data.replacement.id, supersedesId: created.id }),
    ]));
  });
});
