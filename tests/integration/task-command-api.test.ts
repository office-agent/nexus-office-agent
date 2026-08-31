// Requirements: PR-009, PR-010, PR-011, PR-012, MR-046, MR-047, MR-048, MR-049, MR-050, AR-011, SR-007, AC-012, AC-013
import { describe, expect, it } from "vitest";
import { GET as getWorkspace } from "@/app/api/v1/task-command/workspace/route";
import { POST as publishMission } from "@/app/api/v1/task-command/missions/route";
import { POST as claimTask } from "@/app/api/v1/task-command/packages/[id]/claim/route";
import { POST as transitionTask } from "@/app/api/v1/task-command/packages/[id]/transition/route";
import { POST as publishMessage } from "@/app/api/v1/task-command/message-pools/messages/route";
import { POST as feedbackMessage } from "@/app/api/v1/task-command/message-pools/messages/[id]/feedback/route";
import { GET as getHandoffTrail, POST as initiateHandoff } from "@/app/api/v1/task-command/packages/[id]/handoffs/route";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { InMemoryTaskCommandRepository, DEMO_PRODUCT_OWNER_ID } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

function request(url: string, body?: unknown) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-trace-id": "task-command-api-test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Task command HTTP API", () => {
  it("publishes, exposes, atomically claims and advances a task package", async () => {
    const initial = await getWorkspace(request("http://localhost/api/v1/task-command/workspace"));
    const initialPayload = await initial.json();
    const conversationId = initialPayload.data.conversation.id as string;
    const marker = crypto.randomUUID().slice(0, 8);
    const published = await publishMission(request("http://localhost/api/v1/task-command/missions", {
      conversationId,
      title: `API 验收冲刺 ${marker}`,
      objective: "验证任务发布、承接和状态推进接口。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: `开放承接包 ${marker}`,
        description: "由任一有权限成员主动承接。",
        acceptanceCriteria: "提供完成证据并进入验收。",
        requiredSkills: ["交付"],
        assignmentMode: "open_claim",
        priority: "medium",
        dueAt: "2030-08-30T10:00:00.000Z",
        capacityPoints: 2,
      }],
    }));
    const publishedPayload = await published.json();
    expect(published.status).toBe(201);
    const task = publishedPayload.data.packages[0];
    expect(task).toMatchObject({ status: "published", version: 1 });

    const claimed = await claimTask(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/claim`, { expectedVersion: 1 }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).data.task).toMatchObject({ status: "claimed", version: 2 });

    const staleClaim = await claimTask(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/claim`, { expectedVersion: 1 }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(staleClaim.status).toBe(409);

    const inProgress = await transitionTask(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/transition`, { expectedVersion: 2, nextStatus: "in_progress" }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect((await inProgress.json()).data.task).toMatchObject({ status: "in_progress", version: 3 });

    const workspace = await getWorkspace(request("http://localhost/api/v1/task-command/workspace"));
    const workspacePayload = await workspace.json();
    expect(workspacePayload.data.myTasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, status: "in_progress" })]));
  });

  it("publishes communication and feedback into a message pool without creating a task", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const message = await publishMessage(request("http://localhost/api/v1/task-command/message-pools/messages", {
      poolKey: "company",
      subject: `环境同步 ${marker}`,
      content: "本周三晚间测试环境更新，若有冲突请在本条下补充。",
    }));
    expect(message.status).toBe(201);
    const messagePayload = await message.json();
    const messageId = messagePayload.data.message.id as string;
    const feedback = await feedbackMessage(
      request(`http://localhost/api/v1/task-command/message-pools/messages/${messageId}/feedback`, { content: "产品侧已确认，无阻塞。" }),
      { params: Promise.resolve({ id: messageId }) },
    );
    expect(feedback.status).toBe(201);
    const workspace = await getWorkspace(request("http://localhost/api/v1/task-command/workspace"));
    const payload = await workspace.json();
    const company = payload.data.messagePools.find((pool: { key: string }) => pool.key === "company");
    expect(company.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, feedback: [expect.objectContaining({ content: "产品侧已确认，无阻塞。" })] })]));
  });

  // nexus.md P09 · docs/18 §6 · docs/09 AC-012
  it("resumes task event streams from the last seen sequence without replaying already delivered events", async () => {
    const service = new TaskCommandService(new InMemoryTaskCommandRepository());
    const context = createDevelopmentRequestContext("sse-resume");
    const conversation = (await service.workspace(context)).conversation;
    const published = await service.publishMission(context, {
      conversationId: conversation.id,
      title: "SSE 恢复验证",
      objective: "验证事件流断线恢复只返回新增事件。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: "断线续传验证任务",
        description: "确认断线后只拉取 sequence > cursor 的新增事件。",
        acceptanceCriteria: "返回的事件都是新增事件。",
        requiredSkills: ["交付"],
        assignmentMode: "open_claim",
        priority: "medium",
        dueAt: "2030-08-30T10:00:00.000Z",
        capacityPoints: 1,
      }],
    });
    expect(published.created).toBe(true);

    const firstBatch = await service.events(context, 0, 50);
    expect(firstBatch.length).toBeGreaterThan(0);
    const cursor = firstBatch[firstBatch.length - 1].sequence;
    const resumed = await service.events(context, cursor, 50);
    expect(resumed).toEqual([]);
  });

  it("freezes a task handoff snapshot and holds the transfer chain stable across acceptance", async () => {
    const initial = await getWorkspace(request("http://localhost/api/v1/task-command/workspace"));
    const conversationId = (await initial.json()).data.conversation.id as string;
    const marker = crypto.randomUUID().slice(0, 8);
    const published = await publishMission(request("http://localhost/api/v1/task-command/missions", {
      conversationId,
      title: `交接 API ${marker}`,
      objective: "验证正式任务交接接口保留内容与文件链。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: `交接任务 ${marker}`,
        description: "准备交接资料。",
        acceptanceCriteria: "接收人可核验全部资料。",
        requiredSkills: ["交付"],
        assignmentMode: "direct",
        assigneeId: "10000000-0000-4000-8000-000000000001",
        priority: "high",
        dueAt: "2030-08-30T10:00:00.000Z",
        capacityPoints: 2,
      }],
    }));
    expect(published.status).toBe(201);
    const task = (await published.json()).data.packages[0];

    const handoff = await initiateHandoff(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/handoffs`, {
        expectedVersion: 1,
        toAssigneeId: DEMO_PRODUCT_OWNER_ID,
        note: "资料已校验，请继续完成产品侧复核。",
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(handoff.status).toBe(201);
    const handoffPayload = await handoff.json();
    expect(handoffPayload.data.handoff).toMatchObject({
      status: "pending",
      snapshot: { packageVersion: 1, title: `交接任务 ${marker}` },
      fromAssigneeId: "10000000-0000-4000-8000-000000000001",
      toAssigneeId: DEMO_PRODUCT_OWNER_ID,
    });

    const trail = await getHandoffTrail(request(`http://localhost/api/v1/task-command/packages/${task.id}/handoffs`), { params: Promise.resolve({ id: task.id }) });
    expect((await trail.json()).data.handoffs).toEqual([expect.objectContaining({ id: handoffPayload.data.handoff.id, status: "pending" })]);
  });
});
