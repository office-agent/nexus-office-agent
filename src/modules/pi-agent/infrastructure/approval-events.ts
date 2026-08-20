import { randomUUID } from "node:crypto";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { PiApprovalEvent, PiApprovalEventSink } from "@/src/modules/pi-agent/domain/approval-contracts";

export class PostgresPiApprovalEventSink implements PiApprovalEventSink {
  constructor(private readonly database: TransactionalDatabase) {}

  async append(event: PiApprovalEvent): Promise<void> {
    await this.database.withTenant(event.tenantId, async (db) => {
      const rows = await db.query<{ sequence: number }>(
        `WITH locked AS (
           SELECT id FROM pi_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE
         ), next_event AS (
           SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2
         )
         INSERT INTO pi_session_events(id,tenant_id,pi_session_id,sequence,event_type,payload,trace_id)
         SELECT $3,$1,$2,next_event.sequence,$4,$5,$6 FROM locked,next_event
         RETURNING sequence`,
        [event.tenantId, event.sessionId, randomUUID(), event.eventType, { approvalId: event.approvalId, actorId: event.actorId, ...event.payload }, event.traceId],
      );
      if (!rows[0]) throw new Error("PI_APPROVAL_EVENT_SESSION_NOT_FOUND");
      await db.query("UPDATE pi_sessions SET last_event_sequence=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [event.tenantId, event.sessionId, Number(rows[0].sequence)]);
    });
  }
}

