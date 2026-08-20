import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  PiCheckpoint,
  PiRunCommand,
  PiRunCommandType,
  PiRunEnqueueResult,
  PiRunStore,
  PiSandboxProvider,
  PiSession,
  PiSessionCreateInput,
  PiSessionEvent,
  PiSessionStore,
} from "@/src/modules/pi-agent/domain/contracts";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import { assertPiPermission, assertPiProfileAccess } from "@/src/modules/pi-agent/application/policy";
import { buildPiRunManifest, sha256 } from "@/src/modules/pi-agent/application/manifest";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import type { PiResourceRegistryService } from "@/src/modules/pi-agent/application/resource-registry";
import type { McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";

export type PiAcceptedRun = {
  runId: string;
  commandId: string;
  status: PiRunEnqueueResult["command"]["status"];
  created: boolean;
  session: PiSession;
};

function safePayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return Number(item);
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    }));
  } catch {
    return { serializationError: true };
  }
}

function validIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!key || key.length > 256) throw new Error("PI_IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

function commandNow(): string {
  return new Date().toISOString();
}

function activeCommand(commands: PiRunCommand[]): PiRunCommand | undefined {
  return [...commands]
    .filter((command) => command.type === "prompt" || command.type === "checkpoint")
    .filter((command) => command.status === "accepted" || command.status === "queued" || command.status === "leased")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export class PiAgentService {
  constructor(
    private readonly store: PiSessionStore,
    private readonly sandboxProvider: PiSandboxProvider,
    private readonly runStore: PiRunStore = new InMemoryPiRunStore(),
    private readonly resourceRegistry?: PiResourceRegistryService,
    private readonly mcpRegistry?: McpRegistryService,
  ) {}

  async createSession(context: RequestContext, input: PiSessionCreateInput): Promise<PiSession> {
    if (process.env.NODE_ENV === "production" && this.sandboxProvider.kind !== "firecracker" && this.sandboxProvider.kind !== "kata") {
      throw new Error("PI_SANDBOX_RUNTIME_NOT_READY");
    }
    assertPiProfileAccess(context, input);
    const profile = getPiProfile(input.profile);
    const hasResourceSelection = Boolean(input.skillIds?.length || input.packageIds?.length || input.extensionIds?.length);
    if (hasResourceSelection && !this.resourceRegistry) throw new Error("PI_RESOURCE_REGISTRY_UNAVAILABLE");
    const resources = this.resourceRegistry && hasResourceSelection
      ? await this.resourceRegistry.resolveSkillSet(context, {
        profile: input.profile,
        availableTools: profile.allowedTools,
        skillIds: input.skillIds ?? [],
        packageIds: input.packageIds ?? [],
        extensionIds: input.extensionIds ?? [],
        policyVersion: 1,
      })
      : undefined;
    const hasMcpSelection = Boolean(input.mcpBindingIds?.length);
    if (hasMcpSelection && input.profile !== "integration") throw new Error("PI_MCP_PROFILE_NOT_ALLOWED");
    if (hasMcpSelection && !this.mcpRegistry) throw new Error("PI_MCP_REGISTRY_UNAVAILABLE");
    const mcp = hasMcpSelection ? await this.mcpRegistry!.resolveBindingSet(context, input.profile, input.mcpBindingIds ?? []) : { bindings: [], servers: [] };
    const sessionId = randomUUID();
    const now = commandNow();
    const record: PiSession = {
      id: sessionId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      baseRef: input.baseRef?.trim() || "HEAD",
      baseCommit: input.baseCommit,
      profile: input.profile,
      profileVersion: profile.version,
      status: "created",
      modelPolicy: input.modelPolicy ?? "enterprise-default",
      sandboxProfile: `${this.sandboxProvider.kind}:${input.profile}`,
      networkPolicy: profile.networkPolicy,
      policyVersion: 1,
      skillDigests: resources?.snapshot.skillDigests ?? [],
      mcpServerDigests: mcp.servers.map((server) => server.digest).sort(),
      mcpBindingIds: mcp.bindings.map((binding) => binding.bindingId),
      mcpBindings: mcp.bindings,
      resourceSnapshot: resources?.snapshot,
      sandboxRunId: randomUUID(),
      traceId: context.traceId,
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createSession(record);
    await this.appendEvent(context, sessionId, "session_created", {
      profile: input.profile,
      profileVersion: profile.version,
      sandboxProvider: this.sandboxProvider.kind,
      networkPolicy: profile.networkPolicy,
      skillDigests: [],
      mcpServerDigests: record.mcpServerDigests,
      mcpBindingIds: record.mcpBindingIds,
      mcpBindings: record.mcpBindings,
      policyVersion: record.policyVersion,
      resourceSnapshot: record.resourceSnapshot,
    });
    return this.getSession(context, sessionId);
  }

  async getSession(context: RequestContext, sessionId: string): Promise<PiSession> {
    assertPiPermission(context, "pi:session:read");
    const session = await this.store.getSession(context, sessionId);
    if (!session) throw new Error("PI_SESSION_NOT_FOUND");
    return session;
  }

  async listSessions(context: RequestContext): Promise<PiSession[]> {
    assertPiPermission(context, "pi:session:read");
    return this.store.listSessions(context);
  }

  async sendMessage(context: RequestContext, sessionId: string, message: string, idempotencyKey?: string): Promise<PiAcceptedRun> {
    assertPiPermission(context, "pi:session:write");
    if (!message.trim() || message.length > 100_000) throw new Error("PI_MESSAGE_INVALID");
    return this.enqueueRun(context, await this.getSession(context, sessionId), "prompt", { message }, validIdempotencyKey(idempotencyKey), "message_accepted");
  }

  async interrupt(context: RequestContext, sessionId: string, idempotencyKey?: string): Promise<PiAcceptedRun> {
    assertPiPermission(context, "pi:session:write");
    await this.getSession(context, sessionId);
    const current = activeCommand(await this.runStore.listCommands(context, sessionId));
    if (!current) throw new Error("PI_RUN_NOT_ACTIVE");
    const result = await this.runStore.requestCancel(context, current.runId, "user_interrupt", validIdempotencyKey(idempotencyKey), "interrupt");
    if (result.created) {
      await this.store.updateSession(context, sessionId, { status: "cancelling", updatedAt: commandNow() });
      await this.appendEvent(context, sessionId, "interrupt_requested", { runId: current.runId, commandId: result.command.id });
    }
    return { runId: current.runId, commandId: result.command.id, status: result.command.status, created: result.created, session: await this.getSession(context, sessionId) };
  }

  async events(context: RequestContext, sessionId: string, afterSequence: number, limit = 100): Promise<PiSessionEvent[]> {
    await this.getSession(context, sessionId);
    return this.store.getEvents(context, sessionId, Math.max(0, afterSequence), limit);
  }

  async runs(context: RequestContext, sessionId: string): Promise<PiRunCommand[]> {
    await this.getSession(context, sessionId);
    return this.runStore.listCommands(context, sessionId);
  }

  async run(context: RequestContext, runId: string): Promise<{ manifest: Awaited<ReturnType<PiRunStore["getManifest"]>>; status: Awaited<ReturnType<PiRunStore["getRunStatus"]>>; commands: PiRunCommand[] }> {
    assertPiPermission(context, "pi:session:read");
    const manifest = await this.runStore.getManifest(context, runId);
    if (!manifest) throw new Error("PI_RUN_NOT_FOUND");
    const commands = (await this.runStore.listCommands(context, manifest.sessionId)).filter((command) => command.runId === runId);
    return { manifest, status: await this.runStore.getRunStatus(context, runId), commands };
  }

  async cancelRun(context: RequestContext, runId: string, reason = "user_cancel", idempotencyKey?: string): Promise<PiAcceptedRun> {
    assertPiPermission(context, "pi:session:write");
    const manifest = await this.runStore.getManifest(context, runId);
    if (!manifest) throw new Error("PI_RUN_NOT_FOUND");
    const current = (await this.runStore.listCommands(context, manifest.sessionId))
      .find((command) => command.runId === runId && (command.type === "prompt" || command.type === "checkpoint") && ["accepted", "queued", "leased"].includes(command.status));
    if (!current) throw new Error("PI_RUN_NOT_ACTIVE");
    const result = await this.runStore.requestCancel(context, runId, reason.slice(0, 500), validIdempotencyKey(idempotencyKey));
    if (result.created) {
      await this.store.updateSession(context, manifest.sessionId, { status: "cancelling", updatedAt: commandNow() });
      await this.appendEvent(context, manifest.sessionId, "cancel_requested", { runId, commandId: result.command.id });
    }
    return { runId, commandId: result.command.id, status: result.command.status, created: result.created, session: await this.getSession(context, manifest.sessionId) };
  }

  async createCheckpoint(context: RequestContext, sessionId: string, label: string, idempotencyKey?: string): Promise<PiAcceptedRun> {
    assertPiPermission(context, "pi:workspace:write");
    const normalizedLabel = label.trim().slice(0, 200) || "checkpoint";
    return this.enqueueRun(context, await this.getSession(context, sessionId), "checkpoint", { message: normalizedLabel }, validIdempotencyKey(idempotencyKey), "checkpoint_requested");
  }

  async checkpoints(context: RequestContext, sessionId: string): Promise<PiCheckpoint[]> {
    await this.getSession(context, sessionId);
    return this.store.listCheckpoints(context, sessionId);
  }

  async diff(context: RequestContext, sessionId: string): Promise<{ diff: string; digest: string; files: unknown[] }> {
    await this.getSession(context, sessionId);
    const latest = (await this.store.listCheckpoints(context, sessionId))[0];
    if (!latest || !latest.snapshot || typeof latest.snapshot !== "object") return { diff: "", digest: sha256(""), files: [] };
    const snapshot = latest.snapshot as { diff?: unknown; digest?: unknown; files?: unknown };
    return {
      diff: typeof snapshot.diff === "string" ? snapshot.diff : "",
      digest: typeof snapshot.digest === "string" ? snapshot.digest : latest.diffDigest,
      files: Array.isArray(snapshot.files) ? snapshot.files : [],
    };
  }

  private async enqueueRun(
    context: RequestContext,
    session: PiSession,
    type: PiRunCommandType,
    payload: { message?: string; reason?: string },
    idempotencyKey: string,
    eventType: string,
  ): Promise<PiAcceptedRun> {
    const runId = randomUUID();
    const now = new Date();
    const manifest = buildPiRunManifest(context, session, payload.message ?? payload.reason ?? type, runId, now);
    const command: PiRunCommand = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      sessionId: session.id,
      runId,
      type,
      payload: safePayload(payload) as PiRunCommand["payload"],
      idempotencyKey,
      status: "accepted",
      attempts: 0,
      maxAttempts: 3,
      availableAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const result = await this.runStore.createRun(manifest, command);
    if (result.created) {
      await this.store.updateSession(context, session.id, { status: "queued", updatedAt: commandNow() });
      await this.appendEvent(context, session.id, eventType, {
        runId: result.command.runId,
        commandId: result.command.id,
        manifestDigest: manifest.manifestDigest,
        commandType: type,
        idempotencyKeyDigest: sha256(idempotencyKey),
      });
    }
    return {
      runId: result.command.runId,
      commandId: result.command.id,
      status: result.command.status,
      created: result.created,
      session: await this.getSession(context, session.id),
    };
  }

  private async appendEvent(context: RequestContext, sessionId: string, type: string, payload: unknown): Promise<void> {
    await this.store.appendEvent(context, sessionId, { type, payload: safePayload(payload), traceId: context.traceId });
  }
}
