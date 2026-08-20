import { randomUUID } from "node:crypto";
import type { EventStore } from "@/src/modules/events/application/event-store";
import type { DomainEvent, UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

export class PostgresEventStore implements EventStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async appendOutbox(event: DomainEvent): Promise<void> {
    await this.database.withTenant(event.tenantId, (executor) => executor.query(
      `INSERT INTO outbox_events(id, tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, trace_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.tenantId, event.type, event.aggregateType, event.aggregateId, event.aggregateVersion, event.payload, event.traceId, event.occurredAt],
    ));
  }

  async claimInbound(event: UnifiedEvent): Promise<"accepted" | "duplicate"> {
    return this.database.withTenant(event.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `INSERT INTO inbox_events(id, tenant_id, provider, connection_id, external_event_id, event_type, raw_digest, payload, event_envelope, status, received_at, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'received',now(),$10)
         ON CONFLICT (tenant_id, provider, connection_id, external_event_id) DO NOTHING RETURNING id::text`,
        [randomUUID(), event.tenantId, event.provider, event.connectionId, event.eventId, event.eventType, event.rawDigest, event.payload, event, event.traceId],
      );
      return rows.length > 0 ? "accepted" : "duplicate";
    });
  }

  async markInboundProcessed(event: UnifiedEvent): Promise<void> {
    await this.database.withTenant(event.tenantId, (executor) => executor.query(
      `UPDATE inbox_events SET status='processed', processed_at=now(), attempts=attempts+1, last_error_category=NULL
       WHERE tenant_id=$1 AND provider=$2 AND connection_id=$3 AND external_event_id=$4`,
      [event.tenantId, event.provider, event.connectionId, event.eventId],
    ));
  }

  async markInboundFailed(event: UnifiedEvent, category: string): Promise<void> {
    await this.database.withTenant(event.tenantId, (executor) => executor.query(
      `UPDATE inbox_events SET status='failed', attempts=attempts+1, last_error_category=$5
       WHERE tenant_id=$1 AND provider=$2 AND connection_id=$3 AND external_event_id=$4`,
      [event.tenantId, event.provider, event.connectionId, event.eventId, category],
    ));
  }
}
