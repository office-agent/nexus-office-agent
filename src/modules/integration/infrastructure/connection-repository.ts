import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

export type WebhookConnection = {
  id: string;
  tenantId: string;
  provider: ExternalProvider;
  status: "active" | "degraded";
  secretRef: string;
  transportMode?: "stream" | "http";
};

export interface WebhookConnectionRepository {
  getForWebhook(tenantId: string, connectionId: string, provider: ExternalProvider): Promise<WebhookConnection | null>;
}

export class PostgresConnectionRepository implements WebhookConnectionRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getForWebhook(tenantId: string, connectionId: string, provider: ExternalProvider): Promise<WebhookConnection | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<{ id: string; tenant_id: string; provider: ExternalProvider; status: "active" | "degraded"; secret_ref: string; transport_mode: "stream" | "http" | null }>(
        `SELECT id::text, tenant_id::text, provider, status, secret_ref, transport_mode
         FROM connections WHERE tenant_id=$1 AND id=$2 AND provider=$3 AND status IN ('active','degraded')`,
        [tenantId, connectionId, provider],
      );
      return row ? { id: row.id, tenantId: row.tenant_id, provider: row.provider, status: row.status, secretRef: row.secret_ref, transportMode: row.transport_mode ?? undefined } : null;
    });
  }
}
