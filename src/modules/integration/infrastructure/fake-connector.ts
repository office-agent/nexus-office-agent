import { randomUUID } from "node:crypto";
import { digestPayload, unifiedEventSchema, type UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type {
  CollaborationConnector,
  ConnectorCapability,
  ConnectorHealth,
  ExternalIdentityInput,
  ExternalOrg,
  ExternalPage,
  ExternalReceipt,
  ExternalUser,
  IdentityCandidate,
  InstallationStatus,
  SendMessageCommand,
  TokenMetadata,
  UpdateMessageCommand,
  VerifiedRawEvent,
} from "@/src/modules/integration/domain/connector";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";

export class FakeConnector implements CollaborationConnector {
  readonly sent = new Map<string, { command: SendMessageCommand; receipt: ExternalReceipt }>();
  readonly updated = new Map<string, { command: UpdateMessageCommand; receipt: ExternalReceipt }>();
  readonly capabilities = new Set<ConnectorCapability>([
    "identity",
    "organization.read",
    "message.send",
    "message.update",
    "message.receive",
    "card.interactive",
  ]);

  constructor(readonly provider: ExternalProvider) {}

  async verifyInstallation(): Promise<InstallationStatus> {
    return { valid: true, organizationId: "fixture-org", organizationName: "Fixture Organization", capabilities: [...this.capabilities], issues: [] };
  }

  async exchangeOrRefreshToken(): Promise<TokenMetadata> {
    return { tokenType: this.provider === "wecom" ? "corp" : this.provider === "feishu" ? "tenant" : "app", expiresAt: new Date(Date.now() + 7_200_000).toISOString(), scopes: [] };
  }

  async resolveIdentity(input: ExternalIdentityInput): Promise<IdentityCandidate> {
    return { externalSubjectId: input.externalSubjectId, status: "candidate" };
  }

  async listOrganizations(): Promise<ExternalPage<ExternalOrg>> { return { items: [] }; }
  async listUsers(): Promise<ExternalPage<ExternalUser>> { return { items: [] }; }

  async healthCheck(): Promise<ConnectorHealth> {
    return { status: "healthy", checkedAt: new Date().toISOString(), capabilities: [...this.capabilities], issues: [] };
  }

  async sendMessage(command: SendMessageCommand): Promise<ExternalReceipt> {
    const previous = this.sent.get(command.idempotencyKey);
    if (previous) return previous.receipt;
    const receipt: ExternalReceipt = {
      externalMessageId: `fake-${randomUUID()}`,
      acceptedAt: new Date().toISOString(),
      status: "accepted",
    };
    this.sent.set(command.idempotencyKey, { command, receipt });
    return receipt;
  }

  async updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt> {
    const previous = this.updated.get(command.idempotencyKey);
    if (previous) return previous.receipt;
    const receipt: ExternalReceipt = { externalMessageId: command.externalMessageId, acceptedAt: new Date().toISOString(), status: "accepted" };
    this.updated.set(command.idempotencyKey, { command, receipt });
    return receipt;
  }

  async normalizeInboundEvent(raw: VerifiedRawEvent): Promise<UnifiedEvent[]> {
    const value = raw.body;
    const payload = (value.payload ?? value) as Record<string, unknown>;
    return [
      unifiedEventSchema.parse({
        eventId: String(value.eventId ?? digestPayload(value)),
        provider: this.provider,
        connectionId: raw.connectionId,
        tenantId: raw.tenantId,
        eventType: String(value.eventType),
        occurredAt: String(value.occurredAt ?? raw.receivedAt),
        payload,
        rawDigest: digestPayload(raw.rawBody),
        schemaVersion: 1,
        traceId: raw.traceId || randomUUID(),
      }),
    ];
  }
}
