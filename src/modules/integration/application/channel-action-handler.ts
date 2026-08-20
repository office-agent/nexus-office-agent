import type { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import type { UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import type { TaskCommandService } from "@/src/modules/task-command/application/service";
import type { RequestContext } from "@/src/platform/context/request-context";

export interface ChannelActorContextResolver {
  resolve(input: { tenantId: string; connectionId: string; provider: ExternalProvider; externalUserId: string; traceId: string }): Promise<RequestContext | null>;
}

export class AgentChannelActionHandler {
  constructor(
    private readonly connectors: ConnectorRegistry,
    private readonly contexts: ChannelActorContextResolver,
    private readonly agent: AgentOrchestrator,
    private readonly taskCommand?: TaskCommandService,
  ) {}

  private async resolveActor(event: UnifiedEvent): Promise<{ context: RequestContext; externalUserId: string }> {
    if (event.provider === "internal" || !event.externalActor) throw new Error("CHANNEL_ACTOR_REQUIRED");
    const externalUserId = event.externalActor.id;
    const connector = this.connectors.get(event.provider);
    const identity = await connector.resolveIdentity({ tenantId: event.tenantId, connectionId: event.connectionId, subjectType: "user", externalSubjectId: externalUserId });
    if (identity.status !== "verified" || identity.internalSubjectType !== "user" || !identity.internalSubjectId) throw new Error("EXTERNAL_IDENTITY_UNRESOLVED");
    const context = await this.contexts.resolve({ tenantId: event.tenantId, connectionId: event.connectionId, provider: event.provider, externalUserId, traceId: event.traceId });
    if (!context || context.actorId !== identity.internalSubjectId || context.channel !== event.provider) throw new Error("CHANNEL_CONTEXT_DENIED");
    return { context, externalUserId };
  }

  async handle(event: UnifiedEvent): Promise<void> {
    if (event.eventType !== "card.action") return;
    const actionId = String(event.payload.actionId ?? "");
    const proposalHash = String(event.payload.proposalHash ?? "");
    const expiresAt = String(event.payload.expiresAt ?? "");
    if (!actionId.startsWith("agent.confirm:") || !proposalHash || !expiresAt) throw new Error("CHANNEL_ACTION_REFERENCE_INVALID");
    if (Date.parse(expiresAt) <= Date.now()) throw new Error("CHANNEL_ACTION_EXPIRED");
    const proposalId = actionId.slice("agent.confirm:".length);
    if (!proposalId) throw new Error("CHANNEL_ACTION_REFERENCE_INVALID");
    const { context } = await this.resolveActor(event);
    await this.agent.confirmProposal(context, proposalId, proposalHash);
  }

  async handleMessage(event: UnifiedEvent): Promise<boolean> {
    if (event.eventType !== "message.received" || event.provider !== "wecom") return false;
    if (!this.taskCommand) throw new Error("CHANNEL_MESSAGE_AGENT_NOT_CONFIGURED");
    const message = typeof event.payload.Content === "string" ? event.payload.Content.trim() : "";
    if (!message || message.length > 10_000) throw new Error("CHANNEL_MESSAGE_CONTENT_INVALID");
    const { context, externalUserId } = await this.resolveActor(event);
    const workspace = await this.taskCommand.workspace(context);
    const run = await this.agent.createRun(context, {
      message,
      conversationId: workspace.conversation.id,
      clientRequestId: `channel:${event.provider}:${event.connectionId}:${event.eventId}`,
    });
    let outbound: {
      type: "status_update" | "confirmation";
      title?: string;
      text: string;
      actionId?: string;
      proposalHash?: string;
      expiresAt?: string;
    } = { type: "status_update", text: run.output?.content ?? "Agent 没有返回有效内容，请稍后重试。" };
    if (run.output?.proposalId) {
      const proposal = await this.agent.getProposal(context, run.output.proposalId);
      outbound = {
        type: "confirmation",
        title: "Agent 操作确认",
        text: run.output.content,
        actionId: `agent.confirm:${proposal.id}`,
        proposalHash: proposal.proposalHash,
        expiresAt: proposal.expiresAt,
      };
    }
    await this.connectors.get(event.provider).sendMessage({
      tenantId: event.tenantId,
      connectionId: event.connectionId,
      idempotencyKey: `agent-reply:${event.eventId}:${run.id}`,
      recipient: { type: "user", externalId: externalUserId },
      message: outbound,
    });
    return true;
  }
}
