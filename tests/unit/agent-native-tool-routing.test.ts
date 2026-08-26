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
import { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { InMemoryAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/in-memory-repository";

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
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
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

  it("routes an incomplete create request to an editable task template without formal dispatch", async () => {
    const context = createDevelopmentRequestContext("native-template-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerTaskCommandTools(tools, tasks);
    const model = new ScriptedModel([
      { content: "", toolCalls: [{ id: "call-template-1", name: modelToolName("work.create_task_template"), arguments: { conversationId: conversation.id, title: "API 申请工作" } }] },
      { content: JSON.stringify({ answer: "已创建 API 申请工作模板，缺失内容可以后续补充。", skillsUsed: ["work-orchestration"] }) },
    ]);
    const orchestrator = new AgentOrchestrator(new InMemoryAgentStore(), new ManagementContextProvider(management, tasks), model, tools, createDefaultSkillRegistry(), tasks);
    const run = await orchestrator.createRun(context, { message: "创建一个 API 申请工作", conversationId: conversation.id, clientRequestId: "native-template-route-001" });
    expect(run).toMatchObject({ status: "succeeded", output: { kind: "execution", routing: { skills: ["work-orchestration"], tools: ["work.create_task_template"] } } });
    expect((await tasks.workspace(context)).availableTasks).toEqual([]);
    expect((await tasks.workspace(context)).templates).toMatchObject([{ title: "API 申请工作", isTemplate: true }]);
    expect(model.requests[0].tools?.map(({ name }) => name)).toContain(modelToolName("work.create_task_template"));
  });

  it("lets the model place a non-task communication into a visible message pool without a confirmation proposal", async () => {
    const context = createDevelopmentRequestContext("native-message-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
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
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
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
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    const model = new ScriptedModel([{ content: JSON.stringify({ answer: "当前只能提供分析，不能登记风险。", skillsUsed: ["management-risk"] }) }]);
    const run = await new AgentOrchestrator(new InMemoryAgentStore(), new ManagementContextProvider(management), model, tools)
      .createRun(context, { message: "请登记这一项风险" });
    expect(model.requests[0].tools?.some(({ name }) => name === modelToolName("management.create_risk"))).toBe(false);
    expect(run.output?.routing?.tools).toEqual([]);
  });

  it("binds an omitted conversation id to the primary conversation and captures casual content", async () => {
    const context = createDevelopmentRequestContext("native-casual-memory-route");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const memory = new AgentMemoryService(new InMemoryAgentMemoryRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const model = new ScriptedModel([{ content: JSON.stringify({ answer: "可以先休息一下，工作事项等你准备好再处理。" }) }]);
    const orchestrator = new AgentOrchestrator(
      new InMemoryAgentStore(), new ManagementContextProvider(management, tasks, memory), model,
      new ToolRegistry(), createDefaultSkillRegistry(), tasks, memory,
    );
    const run = await orchestrator.createRun(context, {
      message: "我今天有点累，先聊两句。",
      clientRequestId: "native-casual-memory-route-001",
    });
    expect(run.conversationId).toBe(conversation.id);
    const workspace = await tasks.workspace(context);
    expect(workspace.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    const remembered = await memory.context(context, {
      conversationId: conversation.id, projectId: "30000000-0000-4000-8000-000000000001",
      query: "我今天有点累", limit: 4,
    });
    expect(remembered.entries[0]?.tier).toBe("conversation");
    expect(remembered.summary).toContain("我今天有点累");
  });

  it("keeps the ReAct observation loop intact across a read tool and a final answer", async () => {
    const context = createDevelopmentRequestContext("native-react-loop");
    const management = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
    const tasks = new TaskCommandService(new InMemoryTaskCommandRepository());
    const conversation = (await tasks.workspace(context)).conversation;
    const task = (await tasks.publishMission(context, {
      conversationId: conversation.id,
      title: "ReAct 交接核验",
      objective: "验证只读工具观察结果会回到模型再生成回答。",
      priority: "medium",
      dueAt: "2030-08-20T10:00:00.000Z",
      packages: [{
        title: "核验交接链",
        description: "读取当前任务交接链。",
        acceptanceCriteria: "返回可核验的交接链结果。",
        requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_PRODUCT_OWNER_ID,
        priority: "medium", dueAt: "2030-08-19T10:00:00.000Z", capacityPoints: 1,
      }],
    })).packages[0];
    const tools = new ToolRegistry();
    registerTaskCommandTools(tools, tasks);
    const model = new ScriptedModel([
      { content: "", toolCalls: [{ id: "call-react-read-1", name: modelToolName("work.get_task_handoff_trail"), arguments: { taskId: task.id } }] },
      { content: JSON.stringify({ answer: "已读取交接链，当前没有历史交接记录。" }) },
    ]);
    const store = new InMemoryAgentStore();
    const run = await new AgentOrchestrator(
      store, new ManagementContextProvider(management, tasks), model, tools,
      createDefaultSkillRegistry(), tasks,
    ).createRun(context, {
      message: "读取这个任务的交接链并告诉我结果。",
      conversationId: conversation.id,
      clientRequestId: "native-react-loop-001",
    });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-react-read-1" });
    expect(run.output).toMatchObject({ kind: "execution", routing: { tools: ["work.get_task_handoff_trail"] } });
    expect([...store.toolCalls.values()][0]).toMatchObject({ toolId: "work.get_task_handoff_trail", status: "succeeded" });
  });
});
