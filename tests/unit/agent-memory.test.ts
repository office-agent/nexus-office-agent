// Requirements: PR-006, PR-009, MR-050, AR-012, SR-003, AC-007
import { describe, expect, it } from "vitest";
import { registerAgentMemoryTools } from "@/src/modules/agent-memory/application/agent-tools";
import { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { InMemoryAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/in-memory-repository";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const COLLEAGUE_ID = "10000000-0000-4000-8000-000000000003";

describe("tiered Agent memory", () => {
  it("keeps private long-term memories private while allowing explicitly shared memory only to an authorized reader", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const owner = createDevelopmentRequestContext("memory-owner");
    const privateMemory = await service.remember(owner, {
      summary: "我偏好在周五下午前收到项目复盘初稿。", scopeType: "user", visibility: "private", classification: "internal",
      importance: 70, confidence: 100, sourceRefs: [],
    });
    const sharedMemory = await service.remember(owner, {
      summary: "客户验收材料必须先经过交付负责人复核。", scopeType: "tenant", scopeId: owner.tenantId, visibility: "shared", classification: "internal",
      importance: 90, confidence: 100, sourceRefs: ["policy:acceptance-review"],
    });
    const colleague = { ...createDevelopmentRequestContext("memory-colleague"), actorId: COLLEAGUE_ID, permissions: ["memory:read"] };
    expect((await service.recall(colleague, { query: "验收", includeShared: true, limit: 10 })).map(({ id }) => id)).toEqual([]);
    colleague.permissions.push("memory:read_shared");
    const readable = await service.recall(colleague, { query: "验收", includeShared: true, limit: 10 });
    expect(readable).toEqual([expect.objectContaining({ id: sharedMemory.id, visibility: "shared" })]);
    expect(readable.map(({ id }) => id)).not.toContain(privateMemory.id);
  });

  it("separates conversation, contextual, task and situational memories and only rehydrates authorized scopes", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const context = createDevelopmentRequestContext("memory-tiers");
    const conversationId = "70000000-0000-4000-8000-000000000001";
    const taskId = "71000000-0000-4000-8000-000000000001";
    await service.captureConversation(context, { conversationId, runId: "72000000-0000-4000-8000-000000000001", summary: "本轮围绕客户验收整理了待办与风险，未保存对话原文。" });
    await service.captureContext(context, { conversationId, projectId: "30000000-0000-4000-8000-000000000001", runId: "72000000-0000-4000-8000-000000000004", summary: "当前会话围绕客户验收与交付风险。", citations: [] });
    await service.captureTask(context, { taskId, taskVersion: 3, runId: "72000000-0000-4000-8000-000000000002", summary: "客户验收资料任务正在进行，交付负责人负责收口。", sourceRefs: ["work_package:71000000-0000-4000-8000-000000000001"] });
    await service.captureSituation(context, { projectId: "30000000-0000-4000-8000-000000000001", runId: "72000000-0000-4000-8000-000000000003", summary: "项目健康度为 watch，最高风险是外部验收资料滞后。", citations: [] });
    const remembered = await service.context(context, { conversationId, projectId: "30000000-0000-4000-8000-000000000001", taskIds: [taskId], query: "客户验收交付", limit: 12 });
    expect(remembered.entries.map(({ tier }) => tier)).toEqual(expect.arrayContaining(["conversation", "context", "task", "situational"]));
    expect(remembered.summary).toContain("<untrusted_memory_context>");
    expect(remembered.citations).toHaveLength(remembered.entries.length);

    const outsideScope = await service.context(context, { conversationId, projectId: "30000000-0000-4000-8000-000000000009", taskIds: [], query: "客户验收", limit: 12 });
    expect(outsideScope.entries.map(({ tier }) => tier)).not.toContain("task");
    expect(outsideScope.entries.map(({ tier }) => tier)).not.toContain("situational");
  });

  it("preserves bounded user and assistant content and keeps recent conversation turns visible", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const context = createDevelopmentRequestContext("memory-conversation-content");
    const conversationId = "70000000-0000-4000-8000-000000000002";
    const captured = await service.captureConversation(context, {
      conversationId,
      runId: "72000000-0000-4000-8000-000000000005",
      userMessage: "我今天有点累，先聊两句。",
      assistantMessage: "那就先放松一下，团队协作可以稍后再处理。",
      summary: "结果类型：answer。",
    });
    expect(captured?.summary).toContain("用户：我今天有点累");
    expect(captured?.summary).toContain("助手：那就先放松一下");

    const remembered = await service.context(context, {
      conversationId,
      projectId: "30000000-0000-4000-8000-000000000001",
      query: "我刚才提到自己的什么状态",
      limit: 4,
    });
    expect(remembered.entries[0]).toMatchObject({ tier: "conversation", scopeId: conversationId });
    expect(remembered.summary).toContain("我今天有点累");
  });

  it("requires a confirmation-capable Agent tool before an LLM can write long-term memory", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const registry = new ToolRegistry();
    registerAgentMemoryTools(registry, service);
    const context = createDevelopmentRequestContext("memory-tool-policy");
    const remember = registry.get("memory.remember");
    const recall = registry.get("memory.recall");
    expect(remember.confirmationPolicy).toBe("always");
    expect(remember.riskLevel).toBe(2);
    expect(recall.sideEffect).toBe("none");
    expect(registry.available(context).map(({ id }) => id)).toEqual(expect.arrayContaining(["memory.remember", "memory.recall"]));
  });

  it("expires a memory with optimistic concurrency instead of deleting its audit trail", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const context = createDevelopmentRequestContext("memory-expire");
    const entry = await service.remember(context, {
      summary: "旧版客户联系人只用于历史追溯。", scopeType: "user", visibility: "private", classification: "internal",
      importance: 40, confidence: 70, sourceRefs: [],
    });
    await service.expire(context, entry.id, entry.version);
    expect(await service.recall(context, { query: "客户联系人", includeShared: true, limit: 10 })).toEqual([]);
    await expect(service.expire(context, entry.id, entry.version)).rejects.toThrow("MEMORY_VERSION_CONFLICT");
  });

  // nexus.md P09 · docs/22 §5 · docs/09 AC-003
  it("keeps shared memory isolated by tenant even when both tenants query the same summary", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const tenantA = { ...createDevelopmentRequestContext("memory-tenant-a"), tenantId: "tenant-a-memory", actorId: "actor-a-memory", permissions: ["memory:read", "memory:write", "memory:share", "memory:read_shared"] };
    const tenantB = { ...createDevelopmentRequestContext("memory-tenant-b"), tenantId: "tenant-b-memory", actorId: "actor-b-memory", permissions: ["memory:read", "memory:write", "memory:share", "memory:read_shared"] };

    const aEntry = await service.remember(tenantA, {
      summary: "季度复盘结论：上线后需继续完善客户回访闭环。", scopeType: "tenant", scopeId: tenantA.tenantId, visibility: "shared",
      classification: "internal", importance: 85, confidence: 100, sourceRefs: ["policy:post_release_review"],
    });
    const bEntry = await service.remember(tenantB, {
      summary: "季度复盘结论：上线后需继续完善客户回访闭环。", scopeType: "tenant", scopeId: tenantB.tenantId, visibility: "shared",
      classification: "internal", importance: 85, confidence: 100, sourceRefs: ["policy:post_release_review"],
    });

    const aVisible = await service.recall(tenantA, { query: "季度复盘结论", includeShared: true, limit: 10 });
    const bVisible = await service.recall(tenantB, { query: "季度复盘结论", includeShared: true, limit: 10 });

    expect(aVisible.map(({ id }) => id)).toContain(aEntry.id);
    expect(aVisible.map(({ id }) => id)).not.toContain(bEntry.id);
    expect(bVisible.map(({ id }) => id)).toContain(bEntry.id);
    expect(bVisible.map(({ id }) => id)).not.toContain(aEntry.id);
  });

  it("never rehydrates restricted memories into the model context or persists restricted automatic snapshots", async () => {
    const service = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const context = createDevelopmentRequestContext("restricted-memory");
    const secret = await service.remember(context, {
      summary: "并购谈判结论仅限法务与授权管理层查看。", scopeType: "user", visibility: "private", classification: "restricted",
      importance: 90, confidence: 100, sourceRefs: [],
    });
    expect((await service.recall(context, { query: "并购", includeShared: true, limit: 10 })).map(({ id }) => id)).toContain(secret.id);
    expect((await service.recall(context, { query: "并购", includeShared: true, limit: 10, forModel: true })).map(({ id }) => id)).not.toContain(secret.id);
    expect(await service.captureConversation(context, {
      conversationId: "70000000-0000-4000-8000-000000000099", runId: "72000000-0000-4000-8000-000000000099", summary: "访问令牌: sk_example_sensitive_token",
    })).toBeNull();
  });
});
