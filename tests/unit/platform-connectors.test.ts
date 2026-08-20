// Requirements: PR-004, PR-007, AR-008, AR-009, AR-010, IR-001, IR-004, IR-005, IR-006, IR-007, AC-001, AC-005, AC-006
import { describe, expect, it } from "vitest";
import { renderPlatformMessage } from "@/src/modules/integration/application/card-renderer";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryNotificationDeliveryStore, NotificationRouter } from "@/src/modules/integration/application/notification-router";
import { DingtalkConnector, FeishuConnector, InMemoryConnectorControlPlane, WecomConnector, type ConnectorTransport, type ConnectorTransportResponse } from "@/src/modules/integration/infrastructure/platform-connector";
import { AccessTokenBroker, type OutgoingCredentialSource, type RawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";

class FixtureTransport implements ConnectorTransport {
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string> }> = [];
  constructor(private readonly response: ConnectorTransportResponse = { status: 200, body: { code: 0, message_id: "external-message-1" } }) {}
  async request(input: { method: "GET" | "POST" | "PATCH"; path: string; body?: Record<string, unknown>; headers?: Record<string, string> }): Promise<ConnectorTransportResponse> { this.requests.push(structuredClone(input)); return structuredClone(this.response); }
}

const confirmation = { type: "confirmation" as const, title: "确认风险登记", text: "将登记风险。", actionId: "agent.confirm:proposal-1", proposalHash: "hash-1", expiresAt: "2099-01-01T00:00:00.000Z", deepLink: "https://office.example.test/proposals/1" };

describe("platform connector contracts", () => {
  it.each(["feishu", "dingtalk", "wecom"] as const)("renders %s confirmation with only stable action references", (provider) => {
    const rendered = renderPlatformMessage(provider, confirmation);
    const serialized = JSON.stringify(rendered);
    expect(serialized).toContain("proposal_hash");
    expect(serialized).toContain("agent.confirm:proposal-1");
    expect(serialized).not.toContain("amount");
  });

  it("requires complete and unexpired confirmation references", () => {
    expect(() => renderPlatformMessage("feishu", { type: "confirmation", text: "unsafe" })).toThrowError("CONFIRMATION_REFERENCE_REQUIRED");
    expect(() => renderPlatformMessage("wecom", { ...confirmation, expiresAt: "2020-01-01T00:00:00.000Z" })).toThrowError("CONFIRMATION_EXPIRED");
  });

  it("sends idempotently through each platform's protocol shape", async () => {
    const control = new InMemoryConnectorControlPlane();
    const feishuTransport = new FixtureTransport();
    const dingtalkTransport = new FixtureTransport({ status: 200, body: { processQueryKey: "ding-message-1" } });
    const wecomTransport = new FixtureTransport({ status: 200, body: { errcode: 0, msgid: "wecom-message-1" } });
    const connectors = [new FeishuConnector(feishuTransport, control), new DingtalkConnector(dingtalkTransport, control), new WecomConnector(wecomTransport, control, "1000002")];
    for (const connector of connectors) {
      const command = { tenantId: "tenant-a", connectionId: `connection-${connector.provider}`, idempotencyKey: `delivery-${connector.provider}`, recipient: { type: "user" as const, externalId: "external-user" }, message: confirmation };
      const first = await connector.sendMessage(command);
      const second = await connector.sendMessage(command);
      expect(second.externalMessageId).toBe(first.externalMessageId);
    }
    expect(feishuTransport.requests).toHaveLength(1);
    expect(feishuTransport.requests[0].path).toContain("receive_id_type=open_id");
    expect(dingtalkTransport.requests[0].path).toContain("oToMessages");
    expect(wecomTransport.requests[0].body).toMatchObject({ touser: "external-user", agentid: "1000002", msgtype: "template_card" });
  });

  it("globally deduplicates a notification after primary channel delivery", async () => {
    const registry = new ConnectorRegistry();
    const control = new InMemoryConnectorControlPlane();
    const transport = new FixtureTransport();
    registry.register(new FeishuConnector(transport, control));
    const store = new InMemoryNotificationDeliveryStore();
    const router = new NotificationRouter(registry, store);
    const request = { id: "notification-1", tenantId: "tenant-a", userId: "user-a", message: { type: "info" as const, text: "hello" }, providers: [{ provider: "feishu" as const, connectionId: "connection-f", externalUserId: "ou-1" }] };
    const first = await router.deliver(request);
    const second = await router.deliver(request);
    expect(first.status).toBe("delivered");
    expect(second.receipt?.externalMessageId).toBe(first.receipt?.externalMessageId);
    expect(transport.requests).toHaveLength(1);
  });

  it("atomically claims concurrent notification attempts before side effects", async () => {
    const registry = new ConnectorRegistry();
    const control = new InMemoryConnectorControlPlane();
    const transport = new FixtureTransport();
    registry.register(new FeishuConnector(transport, control));
    const router = new NotificationRouter(registry, new InMemoryNotificationDeliveryStore());
    const request = { id: "notification-concurrent", tenantId: "tenant-a", userId: "user-a", message: { type: "info" as const, text: "hello" }, providers: [{ provider: "feishu" as const, connectionId: "connection-f", externalUserId: "ou-1" }] };
    const results = await Promise.all([router.deliver(request), router.deliver(request)]);
    expect(results.some(({ status }) => status === "delivered")).toBe(true);
    expect(results.every(({ status }) => status === "delivered" || status === "pending")).toBe(true);
    expect(transport.requests).toHaveLength(1);
  });

  it("schedules retry on platform rate limiting and honors retry-after", async () => {
    const registry = new ConnectorRegistry();
    const control = new InMemoryConnectorControlPlane();
    registry.register(new FeishuConnector(new FixtureTransport({ status: 429, body: {}, headers: { "retry-after": "12" } }), control));
    const router = new NotificationRouter(registry, new InMemoryNotificationDeliveryStore(), () => Date.parse("2026-08-05T00:00:00.000Z"));
    const result = await router.deliver({ id: "notification-rate", tenantId: "tenant-a", userId: "user-a", message: { type: "info", text: "hello" }, providers: [{ provider: "feishu", connectionId: "connection-f", externalUserId: "ou-1" }] });
    expect(result).toMatchObject({ status: "retry_scheduled", errorCategory: "RATE_LIMITED", nextAttemptAt: "2026-08-05T00:00:12.000Z" });
  });

  it("halts with an unknown outcome when a successful response has no receipt identifier", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new FeishuConnector(new FixtureTransport({ status: 200, body: { code: 0 } }), new InMemoryConnectorControlPlane()));
    const router = new NotificationRouter(registry, new InMemoryNotificationDeliveryStore());
    const request = { id: "notification-unknown", tenantId: "tenant-a", userId: "user-a", message: { type: "info" as const, text: "hello" }, providers: [{ provider: "feishu" as const, connectionId: "connection-f", externalUserId: "ou-1" }] };
    await expect(router.deliver(request)).resolves.toMatchObject({ status: "unknown", errorCategory: "RECEIPT_ID_MISSING" });
    await expect(router.deliver(request)).resolves.toMatchObject({ status: "unknown" });
  });

  it("caches access tokens and injects provider-specific authentication", async () => {
    const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
    const credentials: OutgoingCredentialSource = { async resolve(_connectionId, provider) { return provider === "feishu" ? { provider, appId: "fixture-app", appSecret: "fixture-secret" } : provider === "dingtalk" ? { provider, clientId: "fixture-client", clientSecret: "fixture-secret" } : { provider, corpId: "fixture-corp", appSecret: "fixture-secret", agentId: "1000002" }; } };
    const http: RawHttpClient = { async request(input) {
      requests.push({ url: input.url, headers: input.headers });
      if (input.url.includes("tenant_access_token")) return { status: 200, body: { tenant_access_token: "fixture-access", expire: 7200 }, headers: {} };
      return { status: 200, body: { code: 0, message_id: "message-auth" }, headers: {} };
    } };
    const broker = new AccessTokenBroker(credentials, http, () => Date.parse("2026-08-05T00:00:00.000Z"));
    const transport = new AuthenticatedConnectorTransport("feishu", "connection-f", broker, http);
    await transport.request({ method: "POST", path: "/open-apis/im/v1/messages", body: { text: "one" } });
    await transport.request({ method: "POST", path: "/open-apis/im/v1/messages", body: { text: "two" } });
    expect(requests.filter(({ url }) => url.includes("tenant_access_token"))).toHaveLength(1);
    expect(requests.at(-1)?.headers?.authorization).toBe("Bearer fixture-access");
  });

  it("treats a provider-level error inside HTTP 200 as degraded health", async () => {
    const connector = new WecomConnector(new FixtureTransport({ status: 200, body: { errcode: 40014, errmsg: "invalid access token" } }), new InMemoryConnectorControlPlane(), "1000002");
    await expect(connector.healthCheck()).resolves.toMatchObject({ status: "degraded", issues: ["PLATFORM_CODE_40014"] });
  });
});
