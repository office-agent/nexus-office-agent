// Requirements: PR-008, MR-050, AR-003, AR-005
import { describe, expect, it } from "vitest";
import { AgentDevelopmentService } from "@/src/modules/agent-development/application/service";
import { InMemoryAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/in-memory-store";
import type { RequestContext } from "@/src/platform/context/request-context";

const context: RequestContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000001",
  sessionId: "development-workflow-test",
  channel: "web",
  traceId: "development-workflow-test",
  roles: ["enterprise_manager"],
  permissions: ["agent_development:read", "agent_development:write", "agent_development:deliver"],
  dataScopes: [{ type: "tenant" }],
};

const handoff = { code: "AGENT-WORKFLOW", name: "Agent Workflow", owner: "研发平台组", objective: "统一研发证据链", scope: ["需求归档", "版本治理"], nonGoals: ["自动部署生产"], acceptanceCriteria: ["五文档完整", "逐版本功能测试通过"] };
const version = { projectVersion: 1, name: "0.1.0", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), diffContent: "diff --git a/a.ts b/a.ts\n+export const ready = true;", features: ["自动归档五文档", "阻止越过门禁"] };

describe("Agent development workflow", () => {
  it("atomically archives a handoff as all five project-to-act documents", async () => {
    const service = new AgentDevelopmentService(new InMemoryAgentDevelopmentStore());
    const project = await service.handoff(context, handoff, "handoff-1");
    expect(project.status).toBe("requirements_archived");
    expect(project.documents).toHaveLength(5);
    expect(new Set(project.documents.map(({ kind }) => kind))).toEqual(new Set(["overview", "progress", "features", "versions", "acceptance"]));
    expect(project.documents.every(({ digest }) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
    expect((await service.handoff(context, handoff, "handoff-1")).id).toBe(project.id);
    await expect(service.handoff(context, { ...handoff, objective: "复用键但更改需求" }, "handoff-1")).rejects.toThrow("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
  });

  it("keeps delivery fail-closed until every major version has a passing functional test", async () => {
    const service = new AgentDevelopmentService(new InMemoryAgentDevelopmentStore());
    const archived = await service.handoff(context, handoff, "handoff-2");
    await expect(service.deliver(context, archived.id, archived.version, "delivery-too-early")).rejects.toThrow("AGENT_DEVELOPMENT_VERSION_REQUIRED");
    const developed = await service.recordVersion(context, archived.id, version, "version-1");
    expect(developed.status).toBe("in_development");
    expect(developed.versions[0].diffDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.deliver(context, developed.id, developed.version, "delivery-without-test")).rejects.toThrow("AGENT_DEVELOPMENT_TEST_GATE_REQUIRED");
    const failed = await service.recordTest(context, developed.id, { projectVersion: developed.version, versionId: developed.versions[0].id, name: "功能回归", cases: ["归档生成"], result: "failed", evidence: "1 failed" }, "test-failed");
    expect(failed.status).toBe("testing");
    await expect(service.deliver(context, failed.id, failed.version, "delivery-after-failed-test")).rejects.toThrow("AGENT_DEVELOPMENT_TEST_GATE_REQUIRED");
  });

  it("replays a major-version idempotency key without duplicating evidence or requiring a stale CAS version", async () => {
    const service = new AgentDevelopmentService(new InMemoryAgentDevelopmentStore());
    const archived = await service.handoff(context, handoff, "handoff-version-replay");
    const developed = await service.recordVersion(context, archived.id, version, "version-replay");
    const replayed = await service.recordVersion(context, archived.id, version, "version-replay");
    expect(replayed.version).toBe(developed.version);
    expect(replayed.versions).toHaveLength(1);
    await expect(service.recordVersion(context, archived.id, { ...version, diffContent: "+different" }, "version-replay")).rejects.toThrow("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
    await expect(service.recordVersion(context, archived.id, { ...version, projectVersion: replayed.version }, "version-new-key")).rejects.toThrow("AGENT_DEVELOPMENT_VERSION_NAME_CONFLICT");
  });

  it("freezes current documents, every version diff and passing test in the delivery manifest", async () => {
    const service = new AgentDevelopmentService(new InMemoryAgentDevelopmentStore());
    const archived = await service.handoff(context, handoff, "handoff-3");
    const developed = await service.recordVersion(context, archived.id, version, "version-3");
    const tested = await service.recordTest(context, developed.id, { projectVersion: developed.version, versionId: developed.versions[0].id, name: "功能回归", cases: ["归档生成", "未归档拒绝"], result: "passed", evidence: "2 passed" }, "test-passed");
    expect(tested.status).toBe("ready_to_deliver");
    const delivered = await service.deliver(context, tested.id, tested.version, "delivery-complete");
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivery).toEqual(expect.objectContaining({ versionIds: [developed.versions[0].id], testIds: [tested.tests[0].id] }));
    expect(Object.keys(delivered.delivery!.documentDigests).sort()).toEqual(["acceptance", "features", "overview", "progress", "versions"]);
    expect(delivered.delivery!.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.recordVersion(context, delivered.id, { ...version, projectVersion: delivered.version, name: "0.2.0" }, "version-after-delivery")).rejects.toThrow("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
  });

  it("rejects stale project versions instead of losing concurrent evidence", async () => {
    const service = new AgentDevelopmentService(new InMemoryAgentDevelopmentStore());
    const archived = await service.handoff(context, handoff, "handoff-4");
    await service.recordVersion(context, archived.id, version, "version-4");
    await expect(service.recordVersion(context, archived.id, { ...version, name: "0.2.0" }, "version-stale")).rejects.toThrow("AGENT_DEVELOPMENT_VERSION_CONFLICT");
  });
});
