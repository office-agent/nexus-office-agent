// Requirements: PR-008, MR-050, AR-003, AR-005
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET, POST as handoff } from "@/app/api/v1/agent-development/projects/route";
import { POST as recordVersion } from "@/app/api/v1/agent-development/projects/[projectId]/versions/route";
import { POST as recordTest } from "@/app/api/v1/agent-development/projects/[projectId]/tests/route";
import { POST as deliver } from "@/app/api/v1/agent-development/projects/[projectId]/delivery/route";

function request(url: string, body: unknown, key: string) {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, "x-trace-id": key }, body: JSON.stringify(body) });
}

describe("Agent development HTTP boundary", () => {
  it("runs the complete archived handoff, version, test and delivery journey", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const createdResponse = await handoff(request("/api/v1/agent-development/projects", { code: `DEV-${suffix}`, name: "Agent Development Flow", owner: "研发负责人", objective: "统一技术团队的交付证据", scope: ["需求", "版本", "测试", "交付"], nonGoals: ["自动发布生产"], acceptanceCriteria: ["五文档完整", "每个版本通过功能测试"] }, `handoff-${suffix}`));
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).data;
    expect(created.documents).toHaveLength(5);
    expect(created.status).toBe("requirements_archived");
    expect(JSON.stringify(created)).not.toContain("tenantId");
    expect(JSON.stringify(created)).not.toContain("createdBy");

    const blockedResponse = await deliver(request(`/api/v1/agent-development/projects/${created.id}/delivery`, { projectVersion: created.version }, `blocked-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(blockedResponse.status).toBe(409);

    const versionResponse = await recordVersion(request(`/api/v1/agent-development/projects/${created.id}/versions`, { projectVersion: created.version, name: "0.1.0", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), diffContent: "diff --git a/flow.ts b/flow.ts\n+export const gated = true;", features: ["需求归档", "交付门禁"] }, `version-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(versionResponse.status).toBe(201);
    const versioned = (await versionResponse.json()).data;
    expect(versioned.versions[0]).toEqual(expect.objectContaining({ name: "0.1.0", diffDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(versioned.versions[0]).not.toHaveProperty("diffContent");

    const replayResponse = await recordVersion(request(`/api/v1/agent-development/projects/${created.id}/versions`, { projectVersion: created.version, name: "0.1.0", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), diffContent: "diff --git a/flow.ts b/flow.ts\n+export const gated = true;", features: ["需求归档", "交付门禁"] }, `version-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(replayResponse.status).toBe(201);
    expect((await replayResponse.json()).data.versions).toHaveLength(1);

    const staleResponse = await recordVersion(request(`/api/v1/agent-development/projects/${created.id}/versions`, { projectVersion: created.version, name: "0.2.0", fromCommit: "b".repeat(40), toCommit: "c".repeat(40), diffContent: "+stale", features: ["并发覆盖"] }, `version-stale-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(staleResponse.status).toBe(409);

    const testResponse = await recordTest(request(`/api/v1/agent-development/projects/${created.id}/tests`, { projectVersion: versioned.version, versionId: versioned.versions[0].id, name: "功能旅程", cases: ["归档五文档", "缺测试阻止交付"], result: "passed", evidence: "2 passed" }, `test-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(testResponse.status).toBe(201);
    const tested = (await testResponse.json()).data;
    expect(tested.status).toBe("ready_to_deliver");

    const deliveryResponse = await deliver(request(`/api/v1/agent-development/projects/${created.id}/delivery`, { projectVersion: tested.version }, `delivery-${suffix}`), { params: Promise.resolve({ projectId: created.id }) });
    expect(deliveryResponse.status).toBe(201);
    const delivered = (await deliveryResponse.json()).data;
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivery).toEqual(expect.objectContaining({ manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), versionIds: [versioned.versions[0].id], testIds: [tested.tests[0].id] }));

    const listResponse = await GET(new Request("http://localhost/api/v1/agent-development/projects"));
    expect(listResponse.status).toBe(200);
    const snapshot = (await listResponse.json()).data;
    expect(snapshot.projects.some((item: { id: string }) => item.id === created.id)).toBe(true);
    expect(snapshot.skills.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["project-to-act", "aawo-agent-tester", "agentops-awesome-list", "repo-task-sync"]));
  });
});
