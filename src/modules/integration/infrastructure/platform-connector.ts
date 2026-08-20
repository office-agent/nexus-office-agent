import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
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
  InstallationInput,
  InstallationStatus,
  SendMessageCommand,
  TokenInput,
  TokenMetadata,
  UpdateMessageCommand,
  VerifiedRawEvent,
} from "@/src/modules/integration/domain/connector";
import { renderPlatformMessage } from "@/src/modules/integration/application/card-renderer";
import { normalizeDingtalkEvent, normalizeFeishuEvent, normalizeWecomEvent } from "@/src/modules/integration/application/event-normalizers";

export type ConnectorTransportResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
export interface ConnectorTransport {
  request(input: { method: "GET" | "POST" | "PATCH"; path: string; body?: Record<string, unknown>; headers?: Record<string, string> }): Promise<ConnectorTransportResponse>;
}

export interface ConnectorControlPlane {
  verifyInstallation(provider: ExternalProvider, input: InstallationInput): Promise<InstallationStatus>;
  token(provider: ExternalProvider, input: TokenInput): Promise<TokenMetadata>;
  resolveIdentity(provider: ExternalProvider, input: ExternalIdentityInput): Promise<IdentityCandidate>;
  organizations(provider: ExternalProvider, cursor?: string): Promise<ExternalPage<ExternalOrg>>;
  users(provider: ExternalProvider, cursor?: string): Promise<ExternalPage<ExternalUser>>;
}

export class InMemoryConnectorControlPlane implements ConnectorControlPlane {
  readonly identities = new Map<string, IdentityCandidate>();
  readonly organizationsByProvider = new Map<ExternalProvider, ExternalOrg[]>();
  readonly usersByProvider = new Map<ExternalProvider, ExternalUser[]>();

  async verifyInstallation(provider: ExternalProvider): Promise<InstallationStatus> {
    return { valid: true, organizationId: `fixture-${provider}`, capabilities: [], issues: [] };
  }
  async token(provider: ExternalProvider): Promise<TokenMetadata> {
    return { tokenType: provider === "feishu" ? "tenant" : provider === "dingtalk" ? "app" : "corp", expiresAt: new Date(Date.now() + 7_200_000).toISOString(), scopes: [] };
  }
  async resolveIdentity(provider: ExternalProvider, input: ExternalIdentityInput): Promise<IdentityCandidate> {
    return this.identities.get(`${provider}:${input.connectionId}:${input.subjectType}:${input.externalSubjectId}`) ?? { externalSubjectId: input.externalSubjectId, status: "not_found" };
  }
  async organizations(provider: ExternalProvider): Promise<ExternalPage<ExternalOrg>> { return { items: structuredClone(this.organizationsByProvider.get(provider) ?? []) }; }
  async users(provider: ExternalProvider): Promise<ExternalPage<ExternalUser>> { return { items: structuredClone(this.usersByProvider.get(provider) ?? []) }; }
}

abstract class BasePlatformConnector implements CollaborationConnector {
  abstract readonly provider: ExternalProvider;
  abstract readonly capabilities: ReadonlySet<ConnectorCapability>;
  protected readonly receipts = new Map<string, ExternalReceipt>();

  constructor(protected readonly transport: ConnectorTransport, protected readonly controlPlane: ConnectorControlPlane) {}

  async verifyInstallation(input: InstallationInput): Promise<InstallationStatus> {
    const status = await this.controlPlane.verifyInstallation(this.provider, input);
    return { ...status, capabilities: [...this.capabilities] };
  }
  exchangeOrRefreshToken(input: TokenInput): Promise<TokenMetadata> { return this.controlPlane.token(this.provider, input); }
  resolveIdentity(input: ExternalIdentityInput): Promise<IdentityCandidate> { return this.controlPlane.resolveIdentity(this.provider, input); }
  listOrganizations(cursor?: string): Promise<ExternalPage<ExternalOrg>> { return this.controlPlane.organizations(this.provider, cursor); }
  listUsers(cursor?: string): Promise<ExternalPage<ExternalUser>> { return this.controlPlane.users(this.provider, cursor); }
  async healthCheck(): Promise<ConnectorHealth> {
    try {
      const response = await this.transport.request({ method: "GET", path: this.healthPath() });
      const platformCode = Number(response.body.code ?? response.body.errcode ?? 0);
      const httpHealthy = response.status >= 200 && response.status < 300;
      const platformHealthy = !Number.isFinite(platformCode) || platformCode === 0;
      const issues = [
        ...(!httpHealthy ? [`HTTP_${response.status}`] : []),
        ...(httpHealthy && !platformHealthy ? [`PLATFORM_CODE_${platformCode}`] : []),
      ];
      return { status: httpHealthy && platformHealthy ? "healthy" : "degraded", checkedAt: new Date().toISOString(), capabilities: [...this.capabilities], issues };
    } catch {
      return { status: "unavailable", checkedAt: new Date().toISOString(), capabilities: [...this.capabilities], issues: ["TRANSPORT_UNAVAILABLE"] };
    }
  }
  protected abstract healthPath(): string;
  abstract sendMessage(command: SendMessageCommand): Promise<ExternalReceipt>;
  abstract updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt>;
  abstract normalizeInboundEvent(raw: VerifiedRawEvent): Promise<import("@/src/modules/events/domain/event-envelope").UnifiedEvent[]>;

  protected async deliver(idempotencyKey: string, input: {
    method: "POST" | "PATCH";
    path: string;
    body: Record<string, unknown>;
    validateResponse?: (body: Record<string, unknown>) => void;
  }): Promise<ExternalReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    const { validateResponse, ...request } = input;
    const response = await this.transport.request({ ...request, headers: { "x-nexus-idempotency-key": idempotencyKey } });
    if (response.status === 429) throw new ConnectorDeliveryError("RATE_LIMITED", Number(response.headers?.["retry-after"] ?? 1));
    if (response.status < 200 || response.status >= 300) throw new ConnectorDeliveryError("PLATFORM_REJECTED");
    const code = Number(response.body.code ?? response.body.errcode ?? 0);
    if (Number.isFinite(code) && code !== 0) throw new ConnectorDeliveryError(`PLATFORM_CODE_${code}`);
    validateResponse?.(response.body);
    const externalMessageId = String(response.body.message_id ?? response.body.messageId ?? response.body.processQueryKey ?? response.body.task_id ?? response.body.msgid ?? "");
    if (!externalMessageId) throw new ConnectorDeliveryError("RECEIPT_ID_MISSING");
    const receipt: ExternalReceipt = { externalMessageId, acceptedAt: new Date().toISOString(), status: "accepted" };
    this.receipts.set(idempotencyKey, receipt);
    return receipt;
  }
}

export class ConnectorDeliveryError extends Error {
  constructor(readonly category: string, readonly retryAfterSeconds?: number) { super(category); }
}

const commonCapabilities: ConnectorCapability[] = ["identity", "organization.read", "message.send", "message.update", "message.receive", "card.interactive"];

export class FeishuConnector extends BasePlatformConnector {
  readonly provider = "feishu" as const;
  readonly capabilities = new Set<ConnectorCapability>([...commonCapabilities, "calendar.read", "approval.read"]);
  protected healthPath(): string { return "/open-apis/tenant/v2/tenant/query"; }
  async sendMessage(command: SendMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    const receiveIdType = command.recipient.type === "user" ? "open_id" : "chat_id";
    return this.deliver(command.idempotencyKey, { method: "POST", path: `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, body: { receive_id: command.recipient.externalId, msg_type: rendered.messageType, content: JSON.stringify(rendered.body) } });
  }
  async updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    return this.deliver(command.idempotencyKey, { method: "PATCH", path: `/open-apis/im/v1/messages/${encodeURIComponent(command.externalMessageId)}`, body: { msg_type: rendered.messageType, content: JSON.stringify(rendered.body) } });
  }
  async normalizeInboundEvent(raw: VerifiedRawEvent) { return normalizeFeishuEvent(raw); }
}

export class DingtalkConnector extends BasePlatformConnector {
  readonly provider = "dingtalk" as const;
  readonly capabilities = new Set<ConnectorCapability>([...commonCapabilities, "calendar.read", "approval.read"]);
  protected healthPath(): string { return "/v1.0/contact/users/me"; }
  async sendMessage(command: SendMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    const user = command.recipient.type === "user";
    const path = user ? "/v1.0/robot/oToMessages/batchSend" : "/v1.0/robot/groupMessages/send";
    const target = user ? { userIds: [command.recipient.externalId] } : { openConversationId: command.recipient.externalId };
    return this.deliver(command.idempotencyKey, { method: "POST", path, body: { ...target, msgKey: rendered.messageType, msgParam: JSON.stringify(rendered.body) } });
  }
  async updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    return this.deliver(command.idempotencyKey, { method: "POST", path: "/v1.0/card/instances", body: { outTrackId: command.externalMessageId, cardData: rendered.body } });
  }
  async normalizeInboundEvent(raw: VerifiedRawEvent) { return normalizeDingtalkEvent(raw); }
}

export class WecomConnector extends BasePlatformConnector {
  readonly provider = "wecom" as const;
  readonly capabilities = new Set<ConnectorCapability>(commonCapabilities);
  constructor(transport: ConnectorTransport, controlPlane: ConnectorControlPlane, private readonly agentId: string) { super(transport, controlPlane); }
  protected healthPath(): string { return "/cgi-bin/get_api_domain_ip"; }
  async sendMessage(command: SendMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    const user = command.recipient.type === "user";
    const path = user ? "/cgi-bin/message/send" : "/cgi-bin/appchat/send";
    const target = user ? { touser: command.recipient.externalId, agentid: this.agentId } : { chatid: command.recipient.externalId };
    return this.deliver(command.idempotencyKey, {
      method: "POST",
      path,
      body: { ...target, msgtype: rendered.messageType, [rendered.messageType]: rendered.body, enable_duplicate_check: 1, duplicate_check_interval: 1800 },
      validateResponse: user
        ? (body) => {
            for (const field of ["invaliduser", "invalidparty", "invalidtag"] as const) {
              if (String(body[field] ?? "").trim()) throw new ConnectorDeliveryError(`WECOM_${field.toUpperCase()}`);
            }
          }
        : undefined,
    });
  }
  async updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt> {
    const rendered = renderPlatformMessage(this.provider, command.message);
    return this.deliver(command.idempotencyKey, { method: "POST", path: "/cgi-bin/message/update_template_card", body: { agentid: this.agentId, response_code: command.externalMessageId, template_card: rendered.body } });
  }
  async normalizeInboundEvent(raw: VerifiedRawEvent) { return normalizeWecomEvent(raw); }
}
