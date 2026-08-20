// Requirements: MR-031, MR-038, MR-042, MR-043, MR-044, AC-002, AC-011, SR-001, SR-002
import { describe, expect, it } from "vitest";
import { POST as createCase } from "@/app/api/v1/management-intelligence/cases/route";
import { POST as confirmAction } from "@/app/api/v1/management-intelligence/channel-actions/[id]/confirm/route";
import { GET as getWorkspace } from "@/app/api/v1/management-intelligence/workspace/route";
import { POST as dispatchWecom } from "@/app/api/v1/management-intelligence/wecom/actions/route";
import { DEMO_WECOM_CONNECTION_ID } from "@/src/modules/management-intelligence/infrastructure/in-memory-repository";
import { DEMO_MANAGER_ID } from "@/src/platform/context/development-context";

function request(url: string, method: "POST" | "GET" = "POST", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", "x-trace-id": "management-api-test" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("management intelligence HTTP API", () => {
  it("uses one versioned business object across the web and WeCom confirmation journey", async () => {
    const createdResponse = await createCase(request("http://localhost/api/v1/management-intelligence/cases", "POST", {
      caseType: "operational_exception", title: "API 旅程中的跨渠道事项", description: "同一个事项必须从网页派发并由渠道确认后原子回写。", severity: "high",
      ownerId: DEMO_MANAGER_ID, dueAt: "2026-08-10T10:00:00.000Z", slaMinutes: 7_200, sourceType: "web", sourceRef: "api-journey:management", relatedObjectRefs: ["journey:AC-011"], evidenceRefs: [],
    }));
    const created = await createdResponse.json();
    expect(createdResponse.status).toBe(201);
    expect(created.data).toMatchObject({ status: "open", version: 1, sourceType: "web" });

    const dispatchResponse = await dispatchWecom(request("http://localhost/api/v1/management-intelligence/wecom/actions", "POST", {
      actionType: "case_accept", resourceId: created.data.id, connectionId: DEMO_WECOM_CONNECTION_ID, externalUserId: "api-wecom-user", expiresInMinutes: 10,
    }));
    const dispatched = await dispatchResponse.json();
    expect(dispatchResponse.status).toBe(202);
    expect(dispatched.data).toMatchObject({ action: { resourceId: created.data.id, expectedVersion: 1, status: "pending" }, delivery: { status: "delivered" } });
    expect(JSON.stringify(dispatched.data.action)).not.toContain("api-wecom-user");

    const confirmedResponse = await confirmAction(request(`http://localhost/api/v1/management-intelligence/channel-actions/${dispatched.data.action.id}/confirm`, "POST", { proposalHash: dispatched.data.action.proposalHash }), { params: Promise.resolve({ id: dispatched.data.action.id }) });
    expect(confirmedResponse.status).toBe(200);
    expect((await confirmedResponse.json()).data).toMatchObject({ status: "executed", resourceId: created.data.id, version: 2 });

    const workspaceResponse = await getWorkspace(request("http://localhost/api/v1/management-intelligence/workspace", "GET"));
    const workspace = await workspaceResponse.json();
    expect(workspaceResponse.status).toBe(200);
    expect(workspace.data.cases.find((item: { id: string }) => item.id === created.data.id)).toMatchObject({ status: "in_progress", ownerId: DEMO_MANAGER_ID, version: 2 });
  });

  it("rejects tenant and actor self-assertion at the strict API boundary", async () => {
    const response = await createCase(request("http://localhost/api/v1/management-intelligence/cases", "POST", {
      tenantId: "00000000-0000-4000-8000-000000000099", createdBy: "10000000-0000-4000-8000-000000000099",
      caseType: "other", title: "非法自报上下文", description: "请求体不得决定租户和执行身份。", severity: "low", dueAt: "2026-08-10T10:00:00.000Z", slaMinutes: 60,
      sourceType: "web", sourceRef: "security:test", relatedObjectRefs: [], evidenceRefs: [],
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
