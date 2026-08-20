// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiRuntimeAdapter } from "@/src/modules/pi-agent/infrastructure/runtime-adapter";
import type { PiSandboxSpec } from "@/src/modules/pi-agent/domain/contracts";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiRunnerWorker } from "@/src/modules/pi-agent/application/runner";
import { PiRunScheduler } from "@/src/modules/pi-agent/application/scheduler";
import { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { InMemoryPiSandboxRunStore } from "@/src/modules/pi-agent/infrastructure/sandbox-run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import type { PiRunnerFaultInjector, PiRunnerFaultPoint } from "@/src/modules/pi-agent/application/runner-faults";

class AbortableProvisionProvider extends VirtualSandboxProvider {
  override async create(spec: PiSandboxSpec, signal?: AbortSignal) {
    return new Promise<Awaited<ReturnType<VirtualSandboxProvider["create"]>>>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("PI_RUN_ABORTED"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("PI_RUN_ABORTED")), { once: true });
    });
  }
}

class RecordingFaultInjector implements PiRunnerFaultInjector {
  readonly points: PiRunnerFaultPoint[] = [];

  async checkpoint(point: PiRunnerFaultPoint): Promise<void> {
    this.points.push(point);
  }
}

const context = (tenantId = "tenant-a", actorId = "actor-a"): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "http-session",
  channel: "web",
  traceId: `trace-${tenantId}`,
  roles: [],
  permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
  dataScopes: [{ type: "tenant" }],
});

function fakeRuntime(options: { prompt?: () => Promise<void>; onAbort?: () => void; events?: unknown[] } = {}): PiRuntimeAdapter {
  const listeners = new Set<(event: never) => void>();
  const runtime = {
    session: {
      prompt: options.prompt ?? (async () => {
        const events = options.events ?? [{ type: "agent_start" }];
        for (const event of events) for (const listener of listeners) listener(event as never);
      }),
      abort: async () => options.onAbort?.(),
    },
    sandbox: { id: "sandbox", root: "virtual://sandbox", provider: "virtual" as const },
    model: {} as never,
    subscribe(listener: (event: never) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispose() { listeners.clear(); },
  };
  return runtime as unknown as PiRuntimeAdapter;
}

describe("Pi Run control plane and Runner boundary", () => {
  it("persists one Run for a repeated idempotency key and never invokes Pi in the control service", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const first = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    const accepted = await Promise.all(Array.from({ length: 100 }, () => service.sendMessage(context(), first.id, "实现一个函数", "request-1")));
    const firstRun = accepted[0];
    const duplicate = accepted[99];

    expect(duplicate).toMatchObject({ runId: firstRun.runId, commandId: firstRun.commandId, created: false });
    expect(new Set(accepted.map((item) => item.runId)).size).toBe(1);
    expect(await runs.listCommands(context(), first.id)).toHaveLength(1);
    expect((await sessions.getEvents(context(), first.id, 0, 100)).map((event) => event.type)).toEqual(["session_created", "message_accepted"]);
  });

  it("lists only the tenant backlog with bounded, status-aware results", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const tenantASession = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const tenantBSession = await service.createSession(context("tenant-b", "actor-b"), { profile: "coding", workspaceId: "workspace-b" });
    const first = await service.sendMessage(context(), tenantASession.id, "队列一", "backlog-a-1");
    const second = await service.sendMessage(context(), tenantASession.id, "队列二", "backlog-a-2");
    await service.sendMessage(context("tenant-b", "actor-b"), tenantBSession.id, "其他租户", "backlog-b-1");

    const limited = await runs.listBacklog("tenant-a", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect([first.runId, second.runId]).toContain(limited[0]?.runId);
    const backlog = await runs.listBacklog("tenant-a");
    expect(backlog).toHaveLength(2);
    expect(backlog.map((command) => command.runId)).toEqual(expect.arrayContaining([first.runId, second.runId]));
    expect((await runs.listBacklog("tenant-a", { statuses: ["acknowledged"] }))).toEqual([]);
    expect((await runs.listBacklog("tenant-b")).every((command) => command.tenantId === "tenant-b")).toBe(true);
    const lease = await runs.claim("tenant-a", { workerId: "backlog-runner", leaseMs: 10_000 });
    expect((await runs.listBacklog("tenant-a", { statuses: ["leased"] })).map((command) => command.id)).toEqual([lease?.id]);
    await expect(runs.listBacklog("tenant-a", { limit: 0 })).rejects.toThrow("PI_RUN_BACKLOG_LIMIT_INVALID");
  });

  it("centralizes claim, release and atomic terminal commits behind the scheduler", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-scheduler" });
    const accepted = await service.sendMessage(context(), session.id, "调度门面", "scheduler-1");
    const scheduler = new PiRunScheduler(runs, { leaseMs: 10_000, maxTenantConcurrency: 1 });
    const claimedAt = new Date(Date.now() + 1_000);
    const first = await scheduler.claimRun("tenant-a", "scheduler-a", claimedAt);

    expect(first).not.toBeNull();
    expect(await scheduler.release(first!, new Date(claimedAt.getTime() + 500), claimedAt)).toBe(true);
    expect((await runs.getCommand(context(), accepted.commandId))?.status).toBe("queued");
    expect((await runs.getCommand(context(), accepted.commandId))?.attempts).toBe(1);

    const second = await scheduler.claimRun("tenant-a", "scheduler-b", new Date(claimedAt.getTime() + 2_000));
    expect(second?.attempts).toBe(2);
    expect(await scheduler.updateRunStatusForLease(second!, "running")).toBe(true);
    expect(await scheduler.complete(second!)).toBe(true);
    expect(await runs.getRunStatus(context(), accepted.runId)).toBe("completed");
    expect((await runs.getCommand(context(), accepted.commandId))?.status).toBe("acknowledged");
    expect(await scheduler.complete(second!)).toBe(false);

    const failed = await service.sendMessage(context(), session.id, "死信", "scheduler-2");
    const failedLease = await scheduler.claimRun("tenant-a", "scheduler-c", new Date(Date.now() + 1_000));
    expect(await scheduler.updateRunStatusForLease(failedLease!, "provisioning")).toBe(true);
    expect(await scheduler.fail(failedLease!, { code: "PI_TEST_FAILURE", digest: "f".repeat(64) })).toBe(true);
    expect(await runs.getRunStatus(context(), failed.runId)).toBe("failed");
    expect((await runs.getCommand(context(), failed.commandId))?.status).toBe("dead_lettered");
    expect((await runs.getCommand(context(), failed.commandId))?.lastErrorCode).toBe("PI_TEST_FAILURE");

    const drained = await service.sendMessage(context(), session.id, "排空", "scheduler-3");
    scheduler.beginDrain();
    expect(await scheduler.claimRun("tenant-a", "scheduler-drained", new Date(Date.now() + 1_000))).toBeNull();
    expect((await runs.getCommand(context(), drained.commandId))?.status).toBe("accepted");
  });

  it("rejects cross-tenant manifest reads and stale lease tokens", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    const accepted = await service.sendMessage(context(), session.id, "检查测试", "request-2");
    expect(await runs.getManifest(context("tenant-b", "actor-a"), accepted.runId)).toBeNull();
    const lease = await runs.claim("tenant-a", { workerId: "runner-1", leaseMs: 10_000 });
    expect(lease).not.toBeNull();
    expect(await runs.renew({ ...lease!, leaseToken: "stale" }, "runner-1", 10_000)).toBe(false);
    expect(await runs.acknowledge({ ...lease!, leaseToken: "stale" }, "acknowledged")).toBe(false);
  });

  it("enforces the Run state machine instead of allowing a queued Run to jump to terminal", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    const accepted = await service.sendMessage(context(), session.id, "校验状态机", "request-state-machine");

    expect(await runs.updateRunStatus("tenant-a", accepted.runId, "completed")).toBe(false);
    const lease = await runs.claim("tenant-a", { workerId: "runner-state-machine", leaseMs: 10_000 });
    expect(lease).not.toBeNull();
    expect(await runs.updateRunStatusForLease(lease!, "provisioning")).toBe(true);
    expect(await runs.updateRunStatusForLease(lease!, "completed")).toBe(true);
  });

  it("runs Pi only from the Runner, preserves event order and reaches a terminal session", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "读取项目并运行测试", "request-3");
    const factory = vi.fn(async () => fakeRuntime());
    const worker = new PiRunnerWorker(sessions, runs, provider, { runtimeFactory: factory });

    const result = await worker.processTenant("tenant-a", "runner-1");
    const events = await sessions.getEvents(context(), session.id, 0, 100);
    const refreshed = await sessions.getSession(context(), session.id);

    expect(result.status).toBe("succeeded");
    expect(factory).toHaveBeenCalledOnce();
    expect(refreshed?.status).toBe("succeeded");
    expect(events.map((event) => event.type)).toEqual(["session_created", "message_accepted", "run_leased", "run_started", "agent_start", "run_terminal"]);
  });

  it("flushes Runner fault checkpoints around runtime, tool events and terminal commit", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "记录故障边界", "request-fault-checkpoints");
    const faults = new RecordingFaultInjector();
    const sandboxOrchestrator = new SandboxOrchestrator(provider, new InMemoryPiSandboxRunStore(), faults);
    const worker = new PiRunnerWorker(sessions, runs, provider, {
      faultInjector: faults,
      sandboxOrchestrator,
      runtimeFactory: vi.fn(async () => fakeRuntime({
        events: [
          { type: "agent_start" },
          { type: "tool_execution_start", toolName: "read" },
          { type: "tool_execution_end", toolName: "read" },
          { type: "agent_end" },
        ],
      })),
    });

    expect((await worker.processTenant("tenant-a", "runner-fault-checkpoints")).status).toBe("succeeded");
    expect(faults.points).toEqual(expect.arrayContaining([
      "after_claim",
      "before_run_leased_event",
      "after_run_leased_event",
      "before_sandbox_create",
      "after_sandbox_create",
      "before_runtime_create",
      "after_runtime_create",
      "before_prompt",
      "during_prompt",
      "before_tool",
      "after_tool",
      "before_terminal_commit",
    ]));
    const beforeFlush = faults.points.indexOf("before_event_flush");
    const afterFlush = faults.points.indexOf("after_event_flush");
    expect(beforeFlush).toBeGreaterThanOrEqual(0);
    expect(afterFlush).toBeGreaterThan(beforeFlush);
    expect((await sessions.getEvents(context(), session.id, 0, 100)).map((event) => event.type)).toEqual([
      "session_created",
      "message_accepted",
      "run_leased",
      "run_started",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
      "run_terminal",
    ]);
  });

  it("does not retry a Run after the Pi runtime has started and the outcome becomes unknown", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "执行可能超时的任务", "request-4");
    let rejectPrompt: ((error: Error) => void) | undefined;
    const factory = async () => fakeRuntime({
      prompt: () => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }),
      onAbort: () => rejectPrompt?.(new Error("ABORTED_BY_TIMEOUT")),
    });
    const worker = new PiRunnerWorker(sessions, runs, provider, { runtimeFactory: factory, maxDurationMs: 5 });

    const result = await worker.processTenant("tenant-a", "runner-1");
    const refreshed = await sessions.getSession(context(), session.id);
    expect(result.status).toBe("unknown");
    expect(refreshed?.status).toBe("timed_out");
    expect((await runs.listCommands(context(), session.id))[0].status).toBe("unknown");
  });

  it("requeues an expired lease when the previous Runner never started Pi", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "在运行前崩溃", "request-5");
    const claimedAt = new Date();
    const firstLease = await runs.claim("tenant-a", { workerId: "crashed-runner", leaseMs: 1_000, now: claimedAt });
    expect(firstLease).not.toBeNull();

    const factory = vi.fn(async () => fakeRuntime());
    const worker = new PiRunnerWorker(sessions, runs, provider, { runtimeFactory: factory, leaseMs: 1_000 });
    const result = await worker.processTenant("tenant-a", "recovery-runner", new Date(claimedAt.getTime() + 2_000));

    expect(result.status).toBe("retry_scheduled");
    expect(factory).not.toHaveBeenCalled();
    expect((await runs.listCommands(context(), session.id))[0].status).toBe("queued");
    expect((await sessions.getEvents(context(), session.id, 0, 100)).map((event) => event.type)).toContain("run_reclaimed");
  });

  it("marks a reclaimed Run unknown when the previous Runner had started Pi", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "运行中崩溃", "request-6");
    let startedResolve!: () => void;
    let rejectPrompt!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const workerA = new PiRunnerWorker(sessions, runs, provider, {
      leaseMs: 1_000,
      heartbeatEventIntervalMs: 100,
      runtimeFactory: async () => fakeRuntime({
        prompt: () => {
          startedResolve();
          return new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
        },
        onAbort: () => rejectPrompt?.(new Error("ABORTED_AFTER_LEASE_LOSS")),
      }),
    });
    const firstRun = workerA.processTenant("tenant-a", "runner-a");
    await started;

    const workerB = new PiRunnerWorker(sessions, runs, provider, { leaseMs: 1_000, runtimeFactory: vi.fn(async () => fakeRuntime()) });
    const recovered = await workerB.processTenant("tenant-a", "runner-b", new Date(Date.now() + 2_000));
    const firstResult = await firstRun;

    expect(recovered.status).toBe("unknown");
    expect(firstResult.status).toBe("lease_lost");
    expect((await runs.listCommands(context(), session.id))[0].status).toBe("unknown");
    expect((await sessions.getSession(context(), session.id))?.status).toBe("unknown");
  });

  it("uses the detached Runner path for polling and marks started work unknown during drain", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "排空中的任务", "request-7");
    let startedResolve!: () => void;
    let rejectPrompt!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const worker = new PiRunnerWorker(sessions, runs, provider, {
      runtimeFactory: async () => fakeRuntime({
        prompt: () => {
          startedResolve();
          return new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
        },
        onAbort: () => rejectPrompt?.(new Error("ABORTED_FOR_DRAIN")),
      }),
    });

    expect((await worker.processTenantDetached("tenant-a", "runner-drain")).status).toBe("running");
    await started;
    await worker.drain();

    expect((await runs.listCommands(context(), session.id))[0].status).toBe("unknown");
    expect((await sessions.getSession(context(), session.id))?.status).toBe("unknown");
    expect((await sessions.getEvents(context(), session.id, 0, 100)).map((event) => event.type)).toContain("run_unknown");
    expect((await worker.processTenantDetached("tenant-a", "runner-drain")).status).toBe("idle");
  });

  it("requeues drain work only before a Sandbox resource is created", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new AbortableProvisionProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "在资源创建前排空", "request-drain-before-sandbox");
    const worker = new PiRunnerWorker(sessions, runs, provider, { runtimeFactory: vi.fn(async () => fakeRuntime()) });

    const work = worker.processTenantDetached("tenant-a", "runner-drain-before-sandbox");
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.beginDrain();
    await worker.drain();
    await work;

    expect((await runs.listCommands(context(), session.id))[0].status).toBe("queued");
    expect((await sessions.getSession(context(), session.id))?.status).toBe("queued");
    expect((await sessions.getEvents(context(), session.id, 0, 100)).map((event) => event.type)).toContain("run_requeued");
  });

  it("lets an interrupt command bypass the tenant run slot and aborts the active Runner", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new VirtualSandboxProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    const accepted = await service.sendMessage(context(), session.id, "等待中断", "request-interrupt");
    let startedResolve!: () => void;
    let rejectPrompt!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const worker = new PiRunnerWorker(sessions, runs, provider, {
      runtimeFactory: async () => fakeRuntime({
        prompt: () => {
          startedResolve();
          return new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
        },
        onAbort: () => rejectPrompt?.(new Error("ABORTED_BY_INTERRUPT")),
      }),
      heartbeatEventIntervalMs: 10,
    });

    const mainRun = worker.processTenant("tenant-a", "runner-interrupt");
    await started;
    const interrupt = await service.interrupt(context(), session.id, "interrupt-1");
    expect((await runs.getCommand(context(), interrupt.commandId))?.type).toBe("interrupt");
    const interruptResult = await worker.processTenant("tenant-a", "runner-interrupt");
    const mainResult = await mainRun;
    const commands = await runs.listCommands(context(), session.id);
    const events = await sessions.getEvents(context(), session.id, 0, 100);

    expect(interruptResult.status).toBe("succeeded");
    expect(mainResult.status).toBe("succeeded");
    expect(commands.find((command) => command.runId === accepted.runId && command.type === "prompt")?.status).toBe("cancelled");
    expect(commands.find((command) => command.type === "interrupt")?.status).toBe("cancelled");
    expect((await sessions.getSession(context(), session.id))?.status).toBe("cancelled");
    expect(events.filter((event) => event.type === "interrupt_applied")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run_terminal")).toHaveLength(1);
  });

  it("applies the Run timeout while sandbox provisioning is still in flight", async () => {
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const provider = new AbortableProvisionProvider();
    const service = new PiAgentService(sessions, provider, runs);
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "workspace" });
    await service.sendMessage(context(), session.id, "限时创建沙盒", "request-provision-timeout");
    const worker = new PiRunnerWorker(sessions, runs, provider, { maxDurationMs: 10, leaseMs: 1_000, runtimeFactory: vi.fn(async () => fakeRuntime()) });

    const result = await worker.processTenant("tenant-a", "runner-provision-timeout");
    const command = (await runs.listCommands(context(), session.id))[0];
    expect(result.status).toBe("unknown");
    expect(command.status).toBe("unknown");
    expect((await sessions.getSession(context(), session.id))?.status).toBe("timed_out");
  });
});
