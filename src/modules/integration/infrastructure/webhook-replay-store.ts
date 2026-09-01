import type { WebhookReplayClaim, WebhookReplayStore } from "@/src/modules/integration/application/webhook-replay";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

export class InMemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly claims = new Map<string, { expiresAt: number; firstReceivedAt: string }>();

  async claim(input: WebhookReplayClaim): Promise<{ status: "accepted" | "duplicate"; firstReceivedAt: string }> {
    const receivedAt = Date.parse(input.receivedAt);
    for (const [existing, claim] of this.claims) if (claim.expiresAt <= receivedAt) this.claims.delete(existing);
    const key = `${input.tenantId}:${input.connectionId}:${input.provider}:${input.fingerprint}`;
    const existing = this.claims.get(key);
    if (existing) return { status: "duplicate", firstReceivedAt: existing.firstReceivedAt };
    this.claims.set(key, { expiresAt: Date.parse(input.expiresAt), firstReceivedAt: input.receivedAt });
    return { status: "accepted", firstReceivedAt: input.receivedAt };
  }
}

export class PostgresWebhookReplayStore implements WebhookReplayStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async claim(input: WebhookReplayClaim): Promise<{ status: "accepted" | "duplicate"; firstReceivedAt: string }> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      await executor.query(
        "DELETE FROM webhook_replay_claims WHERE tenant_id=$1 AND expires_at <= $2",
        [input.tenantId, input.receivedAt],
      );
      const rows = await executor.query<{ replay_key: string }>(
        `INSERT INTO webhook_replay_claims(tenant_id,connection_id,provider,replay_key,raw_digest,expires_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(tenant_id,connection_id,replay_key) DO NOTHING
         RETURNING replay_key`,
        [input.tenantId, input.connectionId, input.provider, input.fingerprint, input.rawDigest, input.expiresAt, input.receivedAt],
      );
      if (rows.length === 1) return { status: "accepted", firstReceivedAt: input.receivedAt };
      const [existing] = await executor.query<{ created_at: string }>(
        `SELECT created_at::text FROM webhook_replay_claims
         WHERE tenant_id=$1 AND connection_id=$2 AND replay_key=$3`,
        [input.tenantId, input.connectionId, input.fingerprint],
      );
      if (!existing) throw new Error("WEBHOOK_REPLAY_CLAIM_LOST");
      return { status: "duplicate", firstReceivedAt: new Date(existing.created_at).toISOString() };
    });
  }
}
