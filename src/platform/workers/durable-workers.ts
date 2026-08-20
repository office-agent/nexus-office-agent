import { createHash } from "node:crypto";
import type { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { sha256 } from "@/src/modules/agent/domain/agent-run";
import { assertToolPolicy, type AgentTool, type ToolRegistry } from "@/src/modules/agent/domain/tool";
import type { EventStore } from "@/src/modules/events/application/event-store";
import { createDomainEvent, type UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import type { ManagementChannelActionHandler } from "@/src/modules/management-intelligence/application/channel-action-handler";
import type { AuthorizationResolver } from "@/src/platform/identity/authorization-resolver";
import { runWithRequestContext } from "@/src/platform/context/request-context-storage";
import type { RequestContext } from "@/src/platform/context/request-context";
import {
  failureFrom,
  NonRetryableWorkError,
  RetryableWorkError,
  retryAt,
  UnknownOutcomeWorkError,
} from "@/src/platform/workers/contracts";
import {
  PostgresAgentJobRepository,
  PostgresInboxWorkRepository,
  PostgresOutboxWorkRepository,
} from "@/src/platform/workers/postgres-work-repositories";

export type WorkCycleResult = {
  role: "inbox" | "agent" | "outbox" | "pi-runner" | "pi-change-delivery";
  status: "idle" | "running" | "succeeded" | "retry_scheduled" | "failed" | "unknown" | "dead_letter" | "lease_lost";
  workId?: string;
};

function stableUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function codeOf(error: unknown): string {
  return error instanceof Error ? error.message.split(":")[0] || "WORK_FAILED" : "WORK_FAILED";
}

function classify(error: unknown, tool?: AgentTool): RetryableWorkError | NonRetryableWorkError | UnknownOutcomeWorkError {
  if (error instanceof RetryableWorkError || error instanceof NonRetryableWorkError || error instanceof UnknownOutcomeWorkError) return error;
  const code = codeOf(error);
  if (/^(AUTHORIZATION_|AUTHORIZATION_SOURCE_|TOOL_PERMISSION_|TOOL_CHANNEL_|TOOL_DISABLED_|CONFIRMATION_|PROPOSAL_|POLICY_DENIED|PROJECT_NOT_FOUND|EXTERNAL_IDENTITY_|CHANNEL_|INBOUND_EVENT_SCHEMA_)/.test(code)) {
    return new NonRetryableWorkError(code);
  }
  if (tool?.sideEffect.startsWith("external") && /TIMEOUT|UNAVAILABLE|CONNECTION|RECEIPT/.test(code)) {
    return new UnknownOutcomeWorkError(code);
  }
  return new RetryableWorkError(code);
}

async function executeWithTimeout(tool: AgentTool, context: RequestContext, input: Record<string, unknown>, idempotencyKey: string, agentRunId: string): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tool.execute(context, input, { signal: controller.signal, idempotencyKey, agentRunId }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("TOOL_EXECUTION_TIMEOUT"));
        }, tool.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DurableInboundEventHandler {
  constructor(
    private readonly channelActions: AgentChannelActionHandler,
    private readonly events: EventStore,
    private readonly managementChannelActions?: ManagementChannelActionHandler,
  ) {}

  async handle(event: UnifiedEvent): Promise<void> {
    if (event.eventType === "message.received" && await this.channelActions.handleMessage(event)) return;
    if (event.eventType === "card.action") {
      const actionId = String(event.payload.actionId ?? "");
      if (actionId.startsWith("agent.confirm:")) await this.channelActions.handle(event);
      else if (actionId.startsWith("management.confirm:") && this.managementChannelActions) await this.managementChannelActions.handle(event);
      else throw new Error("CHANNEL_ACTION_REFERENCE_INVALID");
      return;
    }
    const outboxId = stableUuid(`inbox:${event.tenantId}:${event.provider}:${event.connectionId}:${event.eventId}`);
    await this.events.appendOutbox(createDomainEvent({
      id: outboxId,
      occurredAt: event.occurredAt,
      type: `integration.${event.eventType}`,
      version: 1,
      tenantId: event.tenantId,
      aggregateType: "integration_event",
      aggregateId: event.eventId,
      aggregateVersion: event.schemaVersion,
      actor: { type: "system", id: event.provider },
      traceId: event.traceId,
      causationId: event.eventId,
      payload: {
        provider: event.provider,
        connectionId: event.connectionId,
        externalEventId: event.eventId,
        eventType: event.eventType,
        rawDigest: event.rawDigest,
      },
    }));
  }
}

export class InboxWorker {
  readonly role = "inbox" as const;
  constructor(
    private readonly jobs: PostgresInboxWorkRepository,
    private readonly handler: DurableInboundEventHandler,
    private readonly leaseMs = 30_000,
    private readonly maxTenantConcurrency = 1,
  ) {}

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    const lease = await this.jobs.claim(tenantId, { workerId, leaseMs: this.leaseMs, maxTenantConcurrency: this.maxTenantConcurrency, now });
    if (!lease) return { role: this.role, status: "idle" };
    try {
      await this.handler.handle(lease.event);
      return await this.jobs.complete(lease, sha256(`processed:${lease.event.eventId}`), new Date())
        ? { role: this.role, status: "succeeded", workId: lease.id }
        : { role: this.role, status: "lease_lost", workId: lease.id };
    } catch (error) {
      const classified = classify(error);
      const failure = failureFrom(classified);
      if (classified instanceof NonRetryableWorkError) {
        return await this.jobs.fail(lease, failure)
          ? { role: this.role, status: "failed", workId: lease.id }
          : { role: this.role, status: "lease_lost", workId: lease.id };
      }
      if (classified instanceof UnknownOutcomeWorkError) {
        return await this.jobs.unknown(lease, failure)
          ? { role: this.role, status: "unknown", workId: lease.id }
          : { role: this.role, status: "lease_lost", workId: lease.id };
      }
      const disposition = await this.jobs.retry(lease, failure, retryAt(lease.attempts));
      return disposition
        ? { role: this.role, status: disposition, workId: lease.id }
        : { role: this.role, status: "lease_lost", workId: lease.id };
    }
  }
}

export class AgentJobWorker {
  readonly role = "agent" as const;
  constructor(
    private readonly jobs: PostgresAgentJobRepository,
    private readonly authorization: AuthorizationResolver,
    private readonly contexts: ManagementContextProvider,
    private readonly tools: ToolRegistry,
    private readonly leaseMs = 30_000,
    private readonly maxTenantConcurrency = 1,
  ) {}

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    const lease = await this.jobs.claim(tenantId, { workerId, leaseMs: this.leaseMs, maxTenantConcurrency: this.maxTenantConcurrency, now });
    if (!lease) return { role: this.role, status: "idle" };
    let tool: AgentTool | undefined;
    try {
      const authorization = await this.authorization.resolve(tenantId, lease.actorId, now);
      if (!authorization) throw new NonRetryableWorkError("AUTHORIZATION_REVOKED");
      const context: RequestContext = {
        tenantId,
        actorId: lease.actorId,
        sessionId: lease.sessionId ?? `worker:${lease.id}`,
        channel: lease.channel,
        traceId: lease.traceId,
        ...authorization,
      };
      tool = this.tools.get(lease.toolId);
      if (tool.version !== lease.toolVersion) throw new NonRetryableWorkError("TOOL_VERSION_CONFLICT");
      const policy = assertToolPolicy(context, tool);
      if (!policy.requiresConfirmation) throw new NonRetryableWorkError("CONFIRMATION_POLICY_CHANGED");
      const projectId = typeof lease.inputPayload.projectId === "string" ? lease.inputPayload.projectId : undefined;
      if (projectId) {
        const current = await this.contexts.build(context, [`project:${projectId}`]);
        for (const [objectId, expectedVersion] of Object.entries(lease.expectedVersions)) {
          if (current.expectedVersions[objectId] !== expectedVersion) throw new NonRetryableWorkError("PROPOSAL_OBJECT_VERSION_CONFLICT");
        }
      }
      const parsed = tool.inputSchema.parse(lease.inputPayload) as Record<string, unknown>;
      const result = await runWithRequestContext(context, () => executeWithTimeout(tool!, context, parsed, lease.idempotencyKey, lease.agentRunId));
      const resultRecord = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : { value: result ?? null };
      return await this.jobs.succeed(lease, resultRecord, sha256(JSON.stringify(resultRecord)))
        ? { role: this.role, status: "succeeded", workId: lease.id }
        : { role: this.role, status: "lease_lost", workId: lease.id };
    } catch (error) {
      const classified = classify(error, tool);
      const failure = failureFrom(classified);
      if (classified instanceof UnknownOutcomeWorkError) {
        return await this.jobs.unknown(lease, failure, classified.message)
          ? { role: this.role, status: "unknown", workId: lease.id }
          : { role: this.role, status: "lease_lost", workId: lease.id };
      }
      if (classified instanceof NonRetryableWorkError) {
        return await this.jobs.fail(lease, failure)
          ? { role: this.role, status: "failed", workId: lease.id }
          : { role: this.role, status: "lease_lost", workId: lease.id };
      }
      const disposition = await this.jobs.retry(lease, failure, retryAt(lease.attempts));
      return disposition
        ? { role: this.role, status: disposition, workId: lease.id }
        : { role: this.role, status: "lease_lost", workId: lease.id };
    }
  }
}

export class OutboxDispatcher {
  readonly role = "outbox" as const;
  constructor(
    private readonly jobs: PostgresOutboxWorkRepository,
    private readonly leaseMs = 30_000,
    private readonly maxTenantConcurrency = 1,
  ) {}

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    const lease = await this.jobs.claim(tenantId, { workerId, leaseMs: this.leaseMs, maxTenantConcurrency: this.maxTenantConcurrency, now });
    if (!lease) return { role: this.role, status: "idle" };
    try {
      await this.jobs.publish(lease, workerId);
      return { role: this.role, status: "succeeded", workId: lease.id };
    } catch (error) {
      if (codeOf(error) === "OUTBOX_LEASE_LOST") return { role: this.role, status: "lease_lost", workId: lease.id };
      const classified = classify(error);
      const failure = failureFrom(classified);
      const disposition = await this.jobs.retry(lease, failure, retryAt(lease.attempts));
      return disposition
        ? { role: this.role, status: disposition, workId: lease.id }
        : { role: this.role, status: "lease_lost", workId: lease.id };
    }
  }
}
