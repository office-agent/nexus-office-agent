// Requirements: PR-009, PR-010, PR-011, PR-012, MR-046, MR-049, MR-050, AR-011, AR-012, SR-007, AC-012, AC-013
import { describe, expect, it } from "vitest";
import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { registerManagementTools } from "@/src/modules/agent/application/management-tools";
import { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import { InMemoryAgentStore } from "@/src/modules/agent/application/store";
import type { ModelGateway, ModelRequest, ModelResponse } from "@/src/modules/agent/domain/model-gateway";
import { createDefaultSkillRegistry } from "@/src/modules/agent/domain/skill";
import { modelToolName, ToolRegistry } from "@/src/modules/agent/domain/tool";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { InMemoryManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEMO_DELIVERY_OWNER_ID, DEMO_PRODUCT_OWNER_ID, InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

class ScriptedModel implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  constructor(private readonly responses: Array<Pick<ModelResponse, "content" | "toolCalls">>) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.cursor++] ?? { content: JSON.stringify({ answer: "已完成。", skillsUsed: [] }) };
    return { provider: "scripted", model: "native-tool-test", inputTokens: 10, outputTokens: 5, latencyMs: 1, ...response };
  }
}

describe("LLM-native Skill and Tool routing", () => {
  it("turns an LLM-selected formal task dispatch into a confirmation gate before any task exists", async () => {
    const context = createDevelopmentRequestContext("native-task-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerTaskCommandTools(tools, tasks);
    const model = new ScriptedModel([
      {
        content: "",
        toolCalls: [{
          id: "call-publish-1",
          name: modelToolName("work.publish_task_bundle"),
          arguments: {
            conversationId: conversation.id,
            title: "上线验收冲刺",
            objective: "完成验收材料并取得客户签字。",
            priority: "high",
            dueAt: "2030-08-18T10:00:00.000Z",
            packages: [{
              title: "整理签字材料",
              description: "汇总测试记录和功能清单。",
              acceptanceCriteria: "形成可签字的 PDF 验收包。",
              requiredSkills: ["交付"],
              assignmentMode: "open_claim",
              priority: "high",
              dueAt: "2030-08-16T10:00:00.000Z",
              capacityPoints: 3,
            }],
          },
        }],
      },
    ]);
    const orchestrator = new AgentOrchestrator(
      new InMemoryAgentStore(),
      new ManagementContextProvider(management, tasks),
      model,
      tools,
      createDefaultSkillRegistry(),
      tasks,
    );

    const run = await orchestrator.createRun(context, {
      message: "这周把上线验收收口，拆开后让合适的人来领。",
      conversationId: conversation.id,
      clientRequestId: "native-task-route-001",
    });

    expect(run).toMatchObject({ status: "awaiting_confirmation", output: { kind: "proposal", routing: { skills: ["work-orchestration"], tools: ["work.publish_task_bundle"] } } });
    expect((await tasks.workspace(context)).availableTasks).toEqual([]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].tools?.map(({ name }) => name)).toContain(modelToolName("work.publish_task_bundle"));
    expect(model.requests[0].messages[0].content).toContain("<trusted_skill_catalog>");
    expect(model.requests[0].messages[1].content).toContain(`主对话ID：${conversation.id}`);
    const persisted = (await tasks.workspace(context)).messages;
    expect(persisted.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(persisted.at(-1)?.route).toEqual({ skills: ["work-orchestration"], tools: ["work.publish_task_bundle"] });
  });

  it("lets the model place a non-task communication into a visible message pool without a confirmation proposal", async () => {
    const context = createDevelopmentRequestContext("native-message-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerTaskCommandTools(tools, tasks);
    const model = new ScriptedModel([
      { content: "", toolCalls: [{ id: "call-message-1", name: modelToolName("communication.publish_message"), arguments: { poolKey: "company", subject: "本周发布节奏同步", content: "测试环境将于周三晚间更新，如有冲突请在消息下反馈。" } }] },
      { content: JSON.stringify({ answer: "已同步到全公司消息池，可直接在该消息下反馈。", skillsUsed: ["company-communication"] }) },
    ]);
    const orchestrator = new AgentOrchestrator(new InMemoryAgentStore(), new ManagementContextProvider(management, tasks), model, tools, createDefaultSkillRegistry(), tasks);
    const run = await orchestrator.createRun(context, { message: "同步一下周三测试环境更新，大家有冲突及时反馈。", conversationId: conversation.id, clientRequestId: "native-message-route-001" });
    expect(run).toMatchObject({ status: "succeeded", output: { kind: "execution", routing: { skills: ["company-communication"], tools: ["communication.publish_message"] } } });
    expect((await tasks.workspace(context)).messagePools.find(({ key }) => key === "company")?.messages).toMatchObject([{ subject: "本周发布节奏同步" }]);
    expect((await tasks.workspace(context)).availableTasks).toEqual([]);
    expect(model.requests[0].tools?.map(({ name }) => name)).toContain(modelToolName("communication.publish_message"));
    expect(model.requests[0].messages[1].content).toContain("可见消息池");
  });

  it("turns an LLM-selected task handoff into a confirmation proposal while exposing a separate read-only chain tool", async () => {
    const context = createDevelopmentRequestContext("native-handoff-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const assigned = (await tasks.publishMission(context, {
      conversationId: conversation.id, title: "客户问题闭环", objective: "持续处理客户验收阶段遗留问题。", priority: "high", dueAt: "2030-08-18T10:00:00.000Z",
      packages: [{ title: "复现客户问题", description: "整理复现步骤与日志。", acceptanceCriteria: "交付完整的问题复现材料。", requiredSkills: ["产品"], assignmentMode: "direct", assigneeId: DEMO_PRODUCT_OWNER_ID, priority: "high", dueAt: "2030-08-16T10:00:00.000Z", capacityPoints: 2 }],
    })).packages[0];
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerTaskCommandTools(tools, tasks);
    const model = new ScriptedModel([{ content: "", toolCalls: [{ id: "call-handoff-1", name: modelToolName("work.initiate_task_handoff"), arguments: {
      taskId: assigned.id, expectedVersion: assigned.version, toAssigneeId: DEMO_DELIVERY_OWNER_ID, note: "客户问题已完成初步复现，请接续整理交付证据。", artifactRefs: ["document:reproduction-v1", "file:customer-log.zip"],
    } }] }]);
    const orchestrator = new AgentOrchestrator(new InMemoryAgentStore(), new ManagementContextProvider(management, tasks), model, tools, createDefaultSkillRegistry(), tasks);
    const run = await orchestrator.createRun(context, { message: "把客户问题交给交付继续处理，复现资料已经在附件里。", conversationId: conversation.id, clientRequestId: "native-handoff-route-001" });
    expect(run).toMatchObject({ status: "awaiting_confirmation", output: { kind: "proposal", routing: { skills: ["work-orchestration"], tools: ["work.initiate_task_handoff"] } } });
    expect((await tasks.taskHandoffTrail(context, assigned.id)).handoffs).toEqual([]);
    expect(model.requests[0].tools?.map(({ name }) => name)).toEqual(expect.arrayContaining([modelToolName("work.initiate_task_handoff"), modelToolName("work.get_task_handoff_trail")]));
  });

  it("does not expose a tool when the actor lacks its permission", async () => {
    const context = createDevelopmentRequestContext("native-permission-filter");
    context.permissions = ["project:read"];
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    const model = new ScriptedModel([{ content: JSON.stringify({ answer: "当前只能提供分析，不能登记风险。", skillsUsed: ["management-risk"] }) }]);
    const run = await new AgentOrchestrator(new InMemoryAgentStore(), new ManagementContextProvider(management), model, tools)
      .createRun(context, { message: "请登记这一项风险" });
    expect(model.requests[0].tools?.some(({ name }) => name === modelToolName("management.create_risk"))).toBe(false);
    expect(run.output?.routing?.tools).toEqual([]);
  });
});
