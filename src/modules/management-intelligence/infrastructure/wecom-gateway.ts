import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryNotificationDeliveryStore, NotificationRouter, type NotificationDeliveryStore } from "@/src/modules/integration/application/notification-router";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import { InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { PostgresNotificationDeliveryStore } from "@/src/modules/integration/infrastructure/postgres-notification-store";
import { AccessTokenBroker, EnvironmentOutgoingCredentialSource, FetchRawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import type { ManagementWecomGateway, WecomActionDelivery } from "@/src/modules/management-intelligence/application/contracts";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

export class RuntimeManagementWecomGateway implements ManagementWecomGateway {
  private readonly http = new FetchRawHttpClient();
  private readonly tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), this.http);
  private readonly controlPlane = new InMemoryConnectorControlPlane();

  constructor(private readonly store: NotificationDeliveryStore) {}

  async deliver(input: Parameters<ManagementWecomGateway["deliver"]>[0]): Promise<WecomActionDelivery> {
    const registry = new ConnectorRegistry();
    registry.register(new WecomConnector(
      new AuthenticatedConnectorTransport("wecom", input.connectionId, this.tokens, this.http),
      this.controlPlane,
      requireWecomAgentId(),
    ));
    const delivery = await new NotificationRouter(registry, this.store).deliver({
      id: input.id,
      tenantId: input.tenantId,
      userId: "management-action-recipient",
      message: input.message,
      providers: [{ provider: "wecom", connectionId: input.connectionId, externalUserId: input.externalUserId, recipientType: "user" }],
    });
    return {
      status: delivery.status === "pending" ? "unknown" : delivery.status,
      attempts: delivery.attempts,
      externalMessageId: delivery.receipt?.externalMessageId,
      errorCategory: delivery.errorCategory,
    };
  }
}

const runtime = globalThis as typeof globalThis & {
  __nexusManagementNotificationStore?: InMemoryNotificationDeliveryStore;
  __nexusManagementNotificationStoreVersion?: number;
};

export function createRuntimeManagementWecomGateway(database?: TransactionalDatabase): RuntimeManagementWecomGateway {
  if (database) return new RuntimeManagementWecomGateway(new PostgresNotificationDeliveryStore(database));
  if (runtime.__nexusManagementNotificationStoreVersion !== 1) {
    runtime.__nexusManagementNotificationStore = new InMemoryNotificationDeliveryStore();
    runtime.__nexusManagementNotificationStoreVersion = 1;
  }
  return new RuntimeManagementWecomGateway(runtime.__nexusManagementNotificationStore!);
}
