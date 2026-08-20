import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { UnifiedEvent } from "@/src/modules/events/domain/event-envelope";

export type ConnectorCapability =
  | "identity"
  | "organization.read"
  | "message.send"
  | "message.update"
  | "message.receive"
  | "card.interactive"
  | "calendar.read"
  | "approval.read";

export type ConnectionStatus = "draft" | "verifying" | "syncing" | "active" | "degraded" | "suspended" | "revoked";

export type InstallationInput = {
  tenantId: string;
  connectionId: string;
  provider: ExternalProvider;
  expectedOrganizationId?: string;
};

export type InstallationStatus = {
  valid: boolean;
  organizationId?: string;
  organizationName?: string;
  capabilities: ConnectorCapability[];
  issues: string[];
};

export type TokenInput = { tenantId: string; connectionId: string; forceRefresh?: boolean };
export type TokenMetadata = { tokenType: "tenant" | "app" | "corp"; expiresAt: string; scopes: string[] };

export type ExternalIdentityInput = {
  tenantId: string;
  connectionId: string;
  subjectType: "user" | "department" | "chat" | "app";
  externalSubjectId: string;
};

export type IdentityCandidate = {
  externalSubjectId: string;
  status: "verified" | "candidate" | "conflict" | "not_found";
  internalSubjectType?: "user" | "org_unit" | "conversation";
  internalSubjectId?: string;
};

export type ExternalOrg = { id: string; parentId?: string; name: string; active: boolean };
export type ExternalUser = { id: string; name: string; departmentIds: string[]; active: boolean; email?: string };
export type ExternalPage<T> = { items: T[]; nextCursor?: string };

export type ConnectorHealth = {
  status: "healthy" | "degraded" | "unavailable" | "unconfigured";
  checkedAt: string;
  capabilities: ConnectorCapability[];
  issues: string[];
};

export type SendMessageCommand = {
  tenantId: string;
  connectionId: string;
  idempotencyKey: string;
  recipient: { type: "user" | "chat"; externalId: string };
  message: {
    type: "info" | "action_required" | "confirmation" | "status_update" | "digest";
    title?: string;
    text: string;
    deepLink?: string;
    actionId?: string;
    proposalHash?: string;
    expiresAt?: string;
  };
};

export type ExternalReceipt = {
  externalMessageId: string;
  acceptedAt: string;
  status: "accepted" | "delivered" | "unknown";
};

export type UpdateMessageCommand = {
  tenantId: string;
  connectionId: string;
  idempotencyKey: string;
  externalMessageId: string;
  message: SendMessageCommand["message"];
};

export type VerifiedRawEvent = {
  tenantId: string;
  connectionId: string;
  provider: ExternalProvider;
  transport: "stream" | "http";
  receivedAt: string;
  rawBody: string;
  body: Record<string, unknown>;
  traceId: string;
};

export interface CollaborationConnector {
  readonly provider: ExternalProvider;
  readonly capabilities: ReadonlySet<ConnectorCapability>;
  verifyInstallation(input: InstallationInput): Promise<InstallationStatus>;
  exchangeOrRefreshToken(input: TokenInput): Promise<TokenMetadata>;
  resolveIdentity(input: ExternalIdentityInput): Promise<IdentityCandidate>;
  listOrganizations(cursor?: string): Promise<ExternalPage<ExternalOrg>>;
  listUsers(cursor?: string): Promise<ExternalPage<ExternalUser>>;
  healthCheck(): Promise<ConnectorHealth>;
  sendMessage(command: SendMessageCommand): Promise<ExternalReceipt>;
  updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt>;
  normalizeInboundEvent(raw: VerifiedRawEvent): Promise<UnifiedEvent[]>;
}
