import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { ExternalReceipt, SendMessageCommand } from "@/src/modules/integration/domain/connector";
import type { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { ConnectorDeliveryError } from "@/src/modules/integration/infrastructure/platform-connector";
import { digestPayload } from "@/src/modules/events/domain/event-envelope";

export type NotificationRequest = {
  id: string;
  tenantId: string;
  userId: string;
  message: SendMessageCommand["message"];
  providers: Array<{ provider: ExternalProvider; connectionId: string; externalUserId: string; recipientType?: "user" | "chat" }>;
};

export type NotificationDelivery = {
  tenantId: string;
  notificationId: string;
  provider: ExternalProvider;
  connectionId: string;
  status: "pending" | "delivered" | "retry_scheduled" | "failed" | "unknown";
  attempts: number;
  receipt?: ExternalReceipt;
  errorCategory?: string;
  nextAttemptAt?: string;
};

export interface NotificationDeliveryStore {
  get(tenantId: string, notificationId: string): Promise<NotificationDelivery | null>;
  claim(input: { tenantId: string; notificationId: string; provider: ExternalProvider; connectionId: string; idempotencyKey: string; recipientDigest: string; messageType: SendMessageCommand["message"]["type"]; payloadDigest: string }): Promise<boolean>;
  save(delivery: NotificationDelivery): Promise<void>;
}

export class InMemoryNotificationDeliveryStore implements NotificationDeliveryStore {
  readonly deliveries = new Map<string, NotificationDelivery>();
  async get(tenantId: string, notificationId: string) { const value = this.deliveries.get(`${tenantId}:${notificationId}`); return value ? structuredClone(value) : null; }
  async claim(input: { tenantId: string; notificationId: string; provider: ExternalProvider; connectionId: string }): Promise<boolean> {
    const key = `${input.tenantId}:${input.notificationId}`;
    const current = this.deliveries.get(key);
    if (current?.status === "pending" || current?.status === "delivered" || current?.status === "unknown") return false;
    if (current?.status === "retry_scheduled" && current.nextAttemptAt && Date.parse(current.nextAttemptAt) > Date.now()) return false;
    this.deliveries.set(key, { tenantId: input.tenantId, notificationId: input.notificationId, provider: input.provider, connectionId: input.connectionId, status: "pending", attempts: current?.attempts ?? 0 });
    return true;
  }
  async save(delivery: NotificationDelivery) { this.deliveries.set(`${delivery.tenantId}:${delivery.notificationId}`, structuredClone(delivery)); }
}

export class NotificationRouter {
  constructor(private readonly connectors: ConnectorRegistry, private readonly store: NotificationDeliveryStore, private readonly now: () => number = () => Date.now()) {}

  async deliver(request: NotificationRequest): Promise<NotificationDelivery> {
    const existing = await this.store.get(request.tenantId, request.id);
    if (existing?.status === "delivered") return existing;
    let lastFailure: NotificationDelivery | null = null;
    for (const target of request.providers) {
      const claimed = await this.store.claim({ tenantId: request.tenantId, notificationId: request.id, provider: target.provider, connectionId: target.connectionId, idempotencyKey: `${request.id}:${target.provider}`, recipientDigest: digestPayload({ type: target.recipientType ?? "user", externalId: target.externalUserId }), messageType: request.message.type, payloadDigest: digestPayload(request.message) });
      if (!claimed) {
        const current = await this.store.get(request.tenantId, request.id);
        if (current) return current;
        throw new Error("NOTIFICATION_CLAIM_FAILED");
      }
      const connector = this.connectors.get(target.provider);
      const attempts = (existing?.provider === target.provider ? existing.attempts : 0) + 1;
      try {
        const receipt = await connector.sendMessage({ tenantId: request.tenantId, connectionId: target.connectionId, idempotencyKey: `${request.id}:${target.provider}`, recipient: { type: target.recipientType ?? "user", externalId: target.externalUserId }, message: request.message });
        const delivery: NotificationDelivery = { tenantId: request.tenantId, notificationId: request.id, provider: target.provider, connectionId: target.connectionId, status: "delivered", attempts, receipt };
        await this.store.save(delivery);
        return delivery;
      } catch (error) {
        const retryable = error instanceof ConnectorDeliveryError && error.category === "RATE_LIMITED";
        const delaySeconds = error instanceof ConnectorDeliveryError && error.retryAfterSeconds ? error.retryAfterSeconds : Math.min(300, 2 ** attempts);
        const category = error instanceof Error ? error.message : "DELIVERY_OUTCOME_UNKNOWN";
        const knownFailure = error instanceof ConnectorDeliveryError && error.category !== "RECEIPT_ID_MISSING"
          || category.includes("UNCONFIGURED") || category.startsWith("CONFIG_REQUIRED:") || category === "CONNECTOR_TOKEN_EXCHANGE_FAILED";
        lastFailure = {
          tenantId: request.tenantId,
          notificationId: request.id,
          provider: target.provider,
          connectionId: target.connectionId,
          status: retryable ? "retry_scheduled" : knownFailure ? "failed" : "unknown",
          attempts,
          errorCategory: error instanceof ConnectorDeliveryError ? error.category : knownFailure ? category : "DELIVERY_OUTCOME_UNKNOWN",
          nextAttemptAt: retryable ? new Date(this.now() + delaySeconds * 1000).toISOString() : undefined,
        };
        await this.store.save(lastFailure);
        if (retryable || lastFailure.status === "unknown") return lastFailure;
      }
    }
    if (!lastFailure) throw new Error("NO_NOTIFICATION_CHANNEL");
    return lastFailure;
  }
}
