// Requirements: PR-004, PR-009, PR-010, MR-046, IR-002, IR-005, SR-001, SR-007, AC-001, AC-012
import { describe, expect, it } from "vitest";
import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { registerManagementTools } from "@/src/modules/agent/application/management-tools";
import { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import { InMemoryAgentStore } from "@/src/modules/agent/application/store";
import { FakeModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryConnectorControlPlane, WecomConnector, type ConnectorTransport } from "@/src/modules/integration/infrastructure/platform-connector";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { InMemoryManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import { DurableInboundEventHandler } from "@/src/platform/workers/durable-workers";

describe("WeCom primary Agent conversation", () => {
  it("re-resolves identity, uses the durable primary conversation and sends one idempotent reply", async () => {
    const sent: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const control = new InMemoryConnectorControlPlane();
    control.identities.set("wecom:connection-w:user:zhangsan", { externalSubjectId: "zhangsan", status: "verified", internalSubjectType: "user", internalSubjectId: DEMO_MANAGER_ID });
    const connector = new WecomConnector({ async request(input) { sent.push(input); return { status: 200, body: { errcode: 0, msgid: "wecom-message-1" } }; } } satisfies ConnectorTransport, control, "1000001");
    const connectors = new ConnectorRegistry();
    connectors.register(connector);

    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerTaskCommandTools(tools, tasks);
    const agent = new AgentOrchestrator(
      new InMemoryAgentStore(),
      new ManagementContextProvider(management, tasks),
      new FakeModelGateway(JSON.stringify({ answer: "当前项目存在交付窗口风险，我已保留引用供你核验。", skillsUsed: ["enterprise-analysis"] })),
      tools,
      undefined,
      tasks,
    );
    const actionHandler = new AgentChannelActionHandler(connectors, {
      async resolve(input) { return { ...createDevelopmentRequestContext(input.traceId), channel: "wecom", sessionId: `wecom:${input.externalUserId}` }; },
    }, agent, tasks);
    const handler = new DurableInboundEventHandler(actionHandler, new InMemoryEventStore());
    const event = {
      eventId: "wecom-inbound-1",
      provider: "wecom" as const,
      connectionId: "connection-w",
      tenantId: DEMO_TENANT_ID,
      eventType: "message.received",
      occurredAt: "2030-08-11T10:00:00.000Z",
      externalActor: { type: "user", id: "zhangsan" },
      payload: { MsgType: "text", Content: "分析当前项目风险" },
      rawDigest: "a".repeat(64),
      schemaVersion: 1,
      traceId: "wecom-agent-message",
    };

    await handler.handle(event);
    await handler.handle(event);

    expect(sent).toHaveLength(1);
    expect(sent[0].path).toContain("/cgi-bin/message/send");
    expect(JSON.stringify(sent[0].body)).toContain("当前项目存在交付窗口风险");
    const workspace = await tasks.workspace(createDevelopmentRequestContext());
    expect(workspace.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(workspace.messages.at(-1)?.route.skills).toEqual([]);
  });
});
