// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox, PiSandboxProvider, PiSandboxResult } from "@/src/modules/pi-agent/domain/contracts";
import type { PiRepositoryBinding } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiRunnerWorker } from "@/src/modules/pi-agent/application/runner";
import { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import { PiWorkspaceValidationService } from "@/src/modules/pi-agent/application/validation-service";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { InMemoryPiSandboxRunStore } from "@/src/modules/pi-agent/infrastructure/sandbox-run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { createCooperativePiRuntime } from "@/src/modules/pi-agent/infrastructure/cooperative-test-runtime";
import {
  InMemoryPiGitCredentialBroker,
  VirtualPiWorkspaceProvider,
} from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { InMemoryPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { InMemoryPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";

const TENANT_ID = "tenant-pi-runner";
const ACTOR_ID = "actor-pi-runner";
const WORKSPACE_ID = "workspace-pi-runner";
const REPOSITORY_ID = "repository-pi-runner";
const BASE_COMMIT = "a".repeat(40);

class ValidationSandboxProvider extends VirtualSandboxProvider {
  readonly commands: string[] = [];

  override async run(sandbox?: PiSandbox, command?: string, signal?: AbortSignal): Promise<PiSandboxResult> {
    if (!sandbox || !command) throw new Error("PI_SANDBOX_COMMAND_INVALID");
    if (signal?.aborted) throw new Error("PI_RUN_ABORTED");
    this.commands.push(command);
    if (command === "test:fail") return { ok: false, output: "one assertion failed\n", exitCode: 1 };
    if (command === "scan:unavailable") return { ok: false, output: "", exitCode: 126, errorCode: "PI_SANDBOX_EXECUTION_DISABLED" };
    return { ok: true, output: `${command} passed\n`, exitCode: 0 };
  }
}

function context(sessionId = "http-session"): RequestContext {
  return {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    sessionId,
    channel: "web",
    traceId: `trace-${sessionId}`,
    roles: [],
    permissions: [
      "pi:session:create",
      "pi:session:read",
      "pi:session:write",
      "pi:workspace:read",
      "pi:workspace:write",
      "pi:sandbox:execute",
    ],
    dataScopes: [{ type: "tenant" }],
  };
}

function repository(): PiRepositoryBinding {
  return {
    id: REPOSITORY_ID,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    provider: "forgejo",
    repositoryRef: "engineering/pi-runner-demo",
    defaultBranch: "main",
    credentialRef: "secret://forgejo/pi-runner-demo",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

async function fixture(workspaceProvider = new VirtualPiWorkspaceProvider(), sandboxProvider: PiSandboxProvider = new VirtualSandboxProvider()) {
  const sessions = new InMemoryPiSessionStore();
  const runs = new InMemoryPiRunStore();
  const sandboxRuns = new InMemoryPiSandboxRunStore();
  const sandboxOrchestrator = new SandboxOrchestrator(sandboxProvider, sandboxRuns);
  const workspaceStore = new InMemoryPiWorkspaceStore();
  await workspaceStore.putRepository(repository());
  const workspaceService = new PiWorkspaceService({
    store: workspaceStore,
    provider: workspaceProvider,
    credentialBroker: new InMemoryPiGitCredentialBroker(),
    objectStorage: new InMemoryPiObjectStorageGateway(),
    sessionStore: sessions,
  });
  const agent = new PiAgentService(sessions, sandboxProvider, runs);
  return { agent, sessions, runs, sandboxProvider, sandboxRuns, sandboxOrchestrator, workspaceStore, workspaceService };
}

function runnerOptions(state: Awaited<ReturnType<typeof fixture>>) {
  return {
    sandboxOrchestrator: state.sandboxOrchestrator,
    workspaceService: state.workspaceService,
    runtimeFactory: async (input: Parameters<typeof createCooperativePiRuntime>[0]) => {
      // Exercise the provider surface after the Runner has mounted the scoped
      // Workspace. This is a deterministic local substitute for model output;
      // it never touches the host filesystem or claims production readiness.
      await input.provider.write(input.sandbox, "src/runner-generated.ts", "export const runnerGenerated = true;\n");
      return createCooperativePiRuntime(input);
    },
  };
}

describe("Pi Runner Vibe Coding execution chain", () => {
  it("executes a prompt through Sandbox, Workspace, cooperative Pi runtime and durable terminal events", async () => {
    const state = await fixture();
    const actorContext = context("prompt-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "实现一个最小函数并运行检查", "runner-prompt-1");

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, runnerOptions(state));
    const result = await worker.processTenant(TENANT_ID, "runner-integration-prompt");

    expect(result.status).toBe("succeeded");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("completed");
    expect((await state.runs.listCommands(actorContext, session.id))[0]).toMatchObject({ status: "acknowledged", attempts: 1 });
    expect(await state.sessions.getSession(actorContext, session.id)).toMatchObject({ status: "succeeded", repositoryId: REPOSITORY_ID, baseCommit: BASE_COMMIT });
    expect((await state.sessions.getEvents(actorContext, session.id, 0, 100)).map((event) => event.type)).toEqual([
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

    const workspaces = await state.workspaceStore.listWorkspaces(actorContext, session.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      status: "destroyed",
      baseCommitSha: BASE_COMMIT,
      ephemeralBranch: expect.stringMatching(/^pi\//),
    });
    const sandboxRuns = await state.sandboxRuns.list(actorContext, session.id);
    expect(sandboxRuns).toHaveLength(1);
    expect(sandboxRuns[0]).toMatchObject({ provider: "virtual", status: "destroyed", destroyVerified: true, runId: accepted.runId });
  });

  it("runs a checkpoint command through the same Runner path and persists its checkpoint before cleanup", async () => {
    const state = await fixture();
    const actorContext = context("checkpoint-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.createCheckpoint(actorContext, session.id, "runner checkpoint", "runner-checkpoint-1");

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, {
      sandboxOrchestrator: state.sandboxOrchestrator,
      workspaceService: state.workspaceService,
      runtimeFactory: async () => { throw new Error("PI_RUNTIME_MUST_NOT_START_FOR_CHECKPOINT"); },
    });
    const result = await worker.processTenant(TENANT_ID, "runner-integration-checkpoint");

    expect(result.status).toBe("succeeded");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("completed");
    const checkpoints = await state.sessions.listCheckpoints(actorContext, session.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ label: "runner checkpoint", gitCommitSha: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await state.sessions.getEvents(actorContext, session.id, 0, 100)).map((event) => event.type)).toContain("checkpoint_created");
    expect((await state.workspaceStore.listWorkspaces(actorContext, session.id))[0]?.status).toBe("destroyed");
    expect((await state.sandboxRuns.list(actorContext, session.id))[0]?.destroyVerified).toBe(true);
  });

  it("runs only a server-resolved test/scan plan and persists scoped report artifacts", async () => {
    const provider = new ValidationSandboxProvider();
    const state = await fixture(new VirtualPiWorkspaceProvider(), provider);
    const actorContext = context("validation-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "执行服务端定义的测试与扫描", "runner-validation-1");
    const validationService = new PiWorkspaceValidationService(state.workspaceService, {
      exec: (execContext, sandbox, command, signal) => state.sandboxOrchestrator.exec(execContext, sandbox, command, signal),
    });

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, {
      ...runnerOptions(state),
      validationService,
      validationPlanResolver: async () => ({
        id: "coding-default",
        version: 1,
        source: "profile",
        checks: [
          { id: "unit", kind: "test", command: "test:pass" },
          { id: "sast", kind: "scan", command: "scan:pass", classification: "confidential" },
        ],
      }),
    });
    const result = await worker.processTenant(TENANT_ID, "runner-integration-validation");

    expect(result.status).toBe("succeeded");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("completed");
    expect(provider.commands).toEqual(["test:pass", "scan:pass"]);
    const artifacts = await state.workspaceService.listArtifacts(actorContext, session.id);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.type).sort()).toEqual(["scan_report", "test_report"]);
    expect(artifacts.every((artifact) => artifact.runId === accepted.runId && artifact.sessionId === session.id && artifact.tenantId === TENANT_ID)).toBe(true);
    const events = await state.sessions.getEvents(actorContext, session.id, 0, 100);
    expect(events.map((event) => event.type)).toContain("validation_started");
    const completed = events.find((event) => event.type === "validation_completed");
    expect(completed?.payload).toMatchObject({ status: "passed", failedCheckIds: [], unknownCheckIds: [], artifactIds: expect.arrayContaining(artifacts.map((artifact) => artifact.id)) });
  });

  it("records a known validation failure as failed/dead-lettered while preserving the report", async () => {
    const provider = new ValidationSandboxProvider();
    const state = await fixture(new VirtualPiWorkspaceProvider(), provider);
    const actorContext = context("validation-failure-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "保留测试失败报告", "runner-validation-failure-1");
    const validationService = new PiWorkspaceValidationService(state.workspaceService, {
      exec: (execContext, sandbox, command, signal) => state.sandboxOrchestrator.exec(execContext, sandbox, command, signal),
    });

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, {
      ...runnerOptions(state),
      validationService,
      validationPlanResolver: () => ({
        id: "coding-required-checks",
        version: 1,
        source: "tenant_policy",
        checks: [{ id: "unit", kind: "test", command: "test:fail" }],
      }),
    });
    const result = await worker.processTenant(TENANT_ID, "runner-integration-validation-failure");

    expect(result.status).toBe("failed");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("failed");
    expect((await state.runs.listCommands(actorContext, session.id))[0]).toMatchObject({ status: "dead_lettered", attempts: 1, lastErrorCode: "PI_VALIDATION_CHECK_FAILED" });
    expect(await state.sessions.getSession(actorContext, session.id)).toMatchObject({ status: "failed" });
    expect((await state.workspaceService.listArtifacts(actorContext, session.id)).map((artifact) => artifact.type)).toEqual(["test_report"]);
    const events = await state.sessions.getEvents(actorContext, session.id, 0, 100);
    expect(events.find((event) => event.type === "validation_completed")?.payload).toMatchObject({ status: "failed", failedCheckIds: ["unit"] });
    expect(events.find((event) => event.type === "run_terminal")?.payload).toMatchObject({ status: "failed" });
    expect(events.map((event) => event.type)).not.toContain("run_unknown");
  });

  it("does not retry when a validation executor is unavailable and records an unknown report", async () => {
    const provider = new ValidationSandboxProvider();
    const state = await fixture(new VirtualPiWorkspaceProvider(), provider);
    const actorContext = context("validation-unknown-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "执行不可用扫描并停止重试", "runner-validation-unknown-1");
    const validationService = new PiWorkspaceValidationService(state.workspaceService, {
      exec: (execContext, sandbox, command, signal) => state.sandboxOrchestrator.exec(execContext, sandbox, command, signal),
    });

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, {
      ...runnerOptions(state),
      validationService,
      validationPlanResolver: () => ({
        id: "coding-unavailable-scan",
        version: 1,
        source: "profile",
        checks: [{ id: "sast", kind: "scan", command: "scan:unavailable" }],
      }),
    });
    const result = await worker.processTenant(TENANT_ID, "runner-integration-validation-unknown");

    expect(result.status).toBe("unknown");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("unknown");
    expect((await state.runs.listCommands(actorContext, session.id))[0]).toMatchObject({ status: "unknown", attempts: 1, lastErrorCode: "PI_VALIDATION_UNKNOWN" });
    expect(await state.sessions.getSession(actorContext, session.id)).toMatchObject({ status: "unknown" });
    expect((await state.workspaceService.listArtifacts(actorContext, session.id)).map((artifact) => artifact.type)).toEqual(["scan_report"]);
    expect((await state.sessions.getEvents(actorContext, session.id, 0, 100)).map((event) => event.type)).toContain("run_unknown");
  });

  it("marks the Run unknown when Workspace cleanup fails instead of publishing a false success", async () => {
    class CleanupFailureProvider extends VirtualPiWorkspaceProvider {
      override async cleanupWorkspace(): Promise<void> {
        throw new Error("PROVIDER_CLEANUP_FAILED");
      }
    }

    const state = await fixture(new CleanupFailureProvider());
    const actorContext = context("cleanup-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "验证清理失败回退", "runner-cleanup-failure-1");

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, runnerOptions(state));
    const result = await worker.processTenant(TENANT_ID, "runner-integration-cleanup-failure");

    expect(result.status).toBe("unknown");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("unknown");
    expect((await state.runs.listCommands(actorContext, session.id))[0]).toMatchObject({ status: "unknown", lastErrorCode: "PI_RUN_CLEANUP_UNKNOWN" });
    expect(await state.sessions.getSession(actorContext, session.id)).toMatchObject({ status: "unknown" });
    expect((await state.sessions.getEvents(actorContext, session.id, 0, 100)).map((event) => event.type)).toContain("run_unknown");
    expect((await state.workspaceStore.listWorkspaces(actorContext, session.id))[0]).toMatchObject({ status: "unknown", failureCode: "PI_WORKSPACE_CLEANUP_UNKNOWN" });
    expect((await state.sandboxRuns.list(actorContext, session.id))[0]).toMatchObject({ status: "destroyed", destroyVerified: true });
  });

  it("keeps a runtime failure unknown when cleanup fails during error recovery", async () => {
    class CleanupFailureProvider extends VirtualPiWorkspaceProvider {
      override async cleanupWorkspace(): Promise<void> {
        throw new Error("PROVIDER_CLEANUP_FAILED");
      }
    }

    const state = await fixture(new CleanupFailureProvider());
    const actorContext = context("runtime-failure-cleanup-session");
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const accepted = await state.agent.sendMessage(actorContext, session.id, "运行时失败时验证清理回退", "runner-runtime-cleanup-failure-1");

    const worker = new PiRunnerWorker(state.sessions, state.runs, state.sandboxProvider, {
      sandboxOrchestrator: state.sandboxOrchestrator,
      workspaceService: state.workspaceService,
      runtimeFactory: async () => { throw new Error("PI_RUNTIME_FAILED_AFTER_RESOURCES"); },
    });
    const result = await worker.processTenant(TENANT_ID, "runner-integration-runtime-cleanup-failure");

    expect(result.status).toBe("unknown");
    expect(await state.runs.getRunStatus(actorContext, accepted.runId)).toBe("unknown");
    expect((await state.runs.listCommands(actorContext, session.id))[0]).toMatchObject({ status: "unknown", attempts: 1, lastErrorCode: "PI_RUN_CLEANUP_UNKNOWN" });
    expect(await state.sessions.getSession(actorContext, session.id)).toMatchObject({ status: "unknown" });
    expect((await state.workspaceStore.listWorkspaces(actorContext, session.id))[0]).toMatchObject({ status: "unknown", failureCode: "PI_WORKSPACE_CLEANUP_UNKNOWN" });
    expect((await state.sandboxRuns.list(actorContext, session.id))[0]).toMatchObject({ status: "destroyed", destroyVerified: true });
  });
});
