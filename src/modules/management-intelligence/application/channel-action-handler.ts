import { createHash } from "node:crypto";
import type { UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import type { ChannelActorContextResolver } from "@/src/modules/integration/application/channel-action-handler";
import type { ManagementIntelligenceService } from "@/src/modules/management-intelligence/application/service";

export class ManagementChannelActionHandler {
  constructor(
    private readonly connectors: ConnectorRegistry,
    private readonly contexts: ChannelActorContextResolver,
    private readonly management: ManagementIntelligenceService,
  ) {}

  async handle(event: UnifiedEvent): Promise<void> {
    if (event.eventType !== "card.action") return;
    if (event.provider === "internal" || !event.externalActor) throw new Error("CHANNEL_ACTOR_REQUIRED");
    const actionId = String(event.payload.actionId ?? "");
    const proposalHash = String(event.payload.proposalHash ?? "");
    const expiresAt = String(event.payload.expiresAt ?? "");
    if (!actionId.startsWith("management.confirm:") || !proposalHash || !expiresAt) throw new Error("CHANNEL_ACTION_REFERENCE_INVALID");
    if (Date.parse(expiresAt) <= Date.now()) throw new Error("CHANNEL_ACTION_EXPIRED");
    const managementActionId = actionId.slice("management.confirm:".length);
    if (!managementActionId) throw new Error("CHANNEL_ACTION_REFERENCE_INVALID");

    const connector = this.connectors.get(event.provider);
    const identity = await connector.resolveIdentity({
      tenantId: event.tenantId,
      connectionId: event.connectionId,
      subjectType: "user",
      externalSubjectId: event.externalActor.id,
    });
    if (identity.status !== "verified" || identity.internalSubjectType !== "user" || !identity.internalSubjectId) throw new Error("EXTERNAL_IDENTITY_UNRESOLVED");
    const context = await this.contexts.resolve({ tenantId: event.tenantId, connectionId: event.connectionId, provider: event.provider, externalUserId: event.externalActor.id, traceId: event.traceId });
    if (!context || context.actorId !== identity.internalSubjectId || context.channel !== event.provider) throw new Error("CHANNEL_CONTEXT_DENIED");
    const recipientDigest = createHash("sha256").update(event.externalActor.id).digest("hex");
    await this.management.confirmChannelAction(context, managementActionId, proposalHash, recipientDigest);
  }
}
