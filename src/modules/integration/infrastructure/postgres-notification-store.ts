import { createHash, randomUUID } from "node:crypto";
import type { NotificationDelivery, NotificationDeliveryStore } from "@/src/modules/integration/application/notification-router";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

type DeliveryRow = {
  tenant_id: string; notification_id: string; provider: "feishu" | "dingtalk" | "wecom"; connection_id: string;
  status: "pending" | "accepted" | "delivered" | "retry_scheduled" | "failed" | "unknown"; attempt_count: number; external_message_id: string | null;
  accepted_at: string | null; last_error_category: string | null; next_attempt_at: string | null;
};

export class PostgresNotificationDeliveryStore implements NotificationDeliveryStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async get(tenantId: string, notificationId: string): Promise<NotificationDelivery | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<DeliveryRow>(
        `SELECT tenant_id::text, notification_id, provider, connection_id::text, status, attempt_count, external_message_id,
                accepted_at::text, last_error_category, next_attempt_at::text
         FROM connector_deliveries WHERE tenant_id=$1 AND notification_id=$2`, [tenantId, notificationId],
      );
      if (!row) return null;
      return {
        tenantId: row.tenant_id, notificationId: row.notification_id, provider: row.provider, connectionId: row.connection_id,
        status: row.status === "accepted" ? "delivered" : row.status, attempts: Number(row.attempt_count),
        receipt: row.external_message_id ? { externalMessageId: row.external_message_id, acceptedAt: row.accepted_at ?? new Date(0).toISOString(), status: "accepted" } : undefined,
        errorCategory: row.last_error_category ?? undefined, nextAttemptAt: row.next_attempt_at ?? undefined,
      };
    });
  }

  async claim(input: { tenantId: string; notificationId: string; provider: "feishu" | "dingtalk" | "wecom"; connectionId: string; idempotencyKey: string; recipientDigest: string; messageType: "info" | "action_required" | "confirmation" | "status_update" | "digest"; payloadDigest: string }): Promise<boolean> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `INSERT INTO connector_deliveries(id, tenant_id, connection_id, provider, notification_id, idempotency_key, recipient_type,
           recipient_digest, message_type, payload_digest, status, attempt_count)
         VALUES ($1,$2,$3,$4,$5,$6,'user',$7,$8,$9,'pending',0)
         ON CONFLICT (tenant_id, notification_id) DO UPDATE SET status='pending', provider=EXCLUDED.provider,
           connection_id=EXCLUDED.connection_id, idempotency_key=EXCLUDED.idempotency_key, updated_at=now()
         WHERE connector_deliveries.status IN ('failed','retry_scheduled')
           AND (connector_deliveries.next_attempt_at IS NULL OR connector_deliveries.next_attempt_at <= now())
         RETURNING id::text`,
        [randomUUID(), input.tenantId, input.connectionId, input.provider, input.notificationId, input.idempotencyKey, input.recipientDigest, input.messageType, input.payloadDigest],
      );
      return rows.length > 0;
    });
  }

  async save(delivery: NotificationDelivery): Promise<void> {
    const receiptId = delivery.receipt?.externalMessageId;
    const digest = createHash("sha256").update(`${delivery.notificationId}:${delivery.provider}`).digest("hex");
    await this.database.withTenant(delivery.tenantId, (executor) => executor.query(
      `INSERT INTO connector_deliveries(id, tenant_id, connection_id, provider, notification_id, idempotency_key, recipient_type,
         recipient_digest, message_type, payload_digest, external_message_id, status, attempt_count, next_attempt_at,
         last_error_category, accepted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'user',$7,'info',$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (tenant_id, notification_id) DO UPDATE SET provider=EXCLUDED.provider, connection_id=EXCLUDED.connection_id,
         external_message_id=EXCLUDED.external_message_id, status=EXCLUDED.status, attempt_count=EXCLUDED.attempt_count,
         next_attempt_at=EXCLUDED.next_attempt_at, last_error_category=EXCLUDED.last_error_category,
         accepted_at=EXCLUDED.accepted_at, updated_at=now()`,
      [randomUUID(), delivery.tenantId, delivery.connectionId, delivery.provider, delivery.notificationId,
        `${delivery.notificationId}:${delivery.provider}`, digest, digest, receiptId ?? null,
        delivery.status === "delivered" ? "accepted" : delivery.status, delivery.attempts, delivery.nextAttemptAt ?? null,
        delivery.errorCategory ?? null, delivery.receipt?.acceptedAt ?? null],
    ));
  }
}
