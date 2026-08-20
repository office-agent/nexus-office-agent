import { digestPayload } from "@/src/modules/events/domain/event-envelope";
import type { WecomApplicationMessageGateway } from "@/src/modules/integration/application/wecom-application-message";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import { ConnectorDeliveryError, InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { AccessTokenBroker, EnvironmentOutgoingCredentialSource, FetchRawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

type DirectoryUser = { userid?: unknown; name?: unknown };

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function assertPlatformSuccess(status: number, body: Record<string, unknown>): void {
  if (status < 200 || status >= 300) throw new ConnectorDeliveryError("PLATFORM_REJECTED");
  const code = Number(body.errcode ?? 0);
  if (Number.isFinite(code) && code !== 0) throw new ConnectorDeliveryError(`PLATFORM_CODE_${code}`);
}

export class RuntimeWecomApplicationMessageGateway implements WecomApplicationMessageGateway {
  private readonly http = new FetchRawHttpClient();
  private readonly tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), this.http);
  private readonly controlPlane = new InMemoryConnectorControlPlane();

  async resolveAndSend(input: Parameters<WecomApplicationMessageGateway["resolveAndSend"]>[0]) {
    const transport = new AuthenticatedConnectorTransport("wecom", input.connectionId, this.tokens, this.http);
    const directory = await transport.request({
      method: "GET",
      path: "/cgi-bin/user/simplelist?department_id=1&fetch_child=1",
    });
    assertPlatformSuccess(directory.status, directory.body);

    const target = normalizedName(input.recipientName);
    const matches = (Array.isArray(directory.body.userlist) ? directory.body.userlist : [])
      .filter((item): item is DirectoryUser => Boolean(item) && typeof item === "object")
      .map((item) => ({ userid: String(item.userid ?? "").trim(), name: String(item.name ?? "").trim() }))
      .filter((item) => item.userid && item.name && normalizedName(item.name) === target);

    if (matches.length === 0) throw new Error("WECOM_RECIPIENT_NOT_FOUND");
    if (matches.length > 1) throw new Error("WECOM_RECIPIENT_AMBIGUOUS");

    const connector = new WecomConnector(transport, this.controlPlane, requireWecomAgentId());
    const receipt = await connector.sendMessage({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey,
      recipient: { type: "user", externalId: matches[0].userid },
      message: { type: "info", text: input.text },
    });

    return {
      status: "accepted" as const,
      recipientName: matches[0].name,
      receiptDigest: digestPayload({ provider: "wecom", externalMessageId: receipt.externalMessageId }),
      sentAt: receipt.acceptedAt,
      secretExposed: false as const,
    };
  }
}
