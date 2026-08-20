import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryNotificationDeliveryStore, NotificationRouter, type NotificationDeliveryStore } from "@/src/modules/integration/application/notification-router";
import { TEST_NOTIFICATION_MESSAGE, type TestNotificationGateway } from "@/src/modules/integration/application/test-notification";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import { DingtalkConnector, FeishuConnector, InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { PostgresNotificationDeliveryStore } from "@/src/modules/integration/infrastructure/postgres-notification-store";
import { AccessTokenBroker, EnvironmentOutgoingCredentialSource, FetchRawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

export class RuntimeTestNotificationGateway implements TestNotificationGateway {
  private readonly http = new FetchRawHttpClient();
  private readonly tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), this.http);
  private readonly controlPlane = new InMemoryConnectorControlPlane();

  constructor(private readonly store: NotificationDeliveryStore) {}

  async deliver(input: Parameters<TestNotificationGateway["deliver"]>[0]) {
    const registry = new ConnectorRegistry();
    const transport = new AuthenticatedConnectorTransport(input.provider, input.connectionId, this.tokens, this.http);
    if (input.provider === "feishu") registry.register(new FeishuConnector(transport, this.controlPlane));
    else if (input.provider === "dingtalk") registry.register(new DingtalkConnector(transport, this.controlPlane));
    else registry.register(new WecomConnector(transport, this.controlPlane, requireWecomAgentId()));

    const router = new NotificationRouter(registry, this.store);
    return router.deliver({
      id: input.id,
      tenantId: input.tenantId,
      userId: "enterprise-acceptance-operator",
      message: TEST_NOTIFICATION_MESSAGE,
      providers: [{ provider: input.provider, connectionId: input.connectionId, externalUserId: input.externalRecipientId, recipientType: input.recipientType }],
    });
  }
}

const runtime = globalThis as typeof globalThis & { __nexusTestNotificationDeliveryStore?: InMemoryNotificationDeliveryStore; __nexusTestNotificationDeliveryStoreVersion?: number };

export function createRuntimeTestNotificationGateway(database?: TransactionalDatabase): RuntimeTestNotificationGateway {
  if (database) return new RuntimeTestNotificationGateway(new PostgresNotificationDeliveryStore(database));
  if (runtime.__nexusTestNotificationDeliveryStoreVersion !== 1) {
    runtime.__nexusTestNotificationDeliveryStore = new InMemoryNotificationDeliveryStore();
    runtime.__nexusTestNotificationDeliveryStoreVersion = 1;
  }
  return new RuntimeTestNotificationGateway(runtime.__nexusTestNotificationDeliveryStore!);
}
