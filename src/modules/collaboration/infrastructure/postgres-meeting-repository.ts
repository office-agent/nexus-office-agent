import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { MeetingRepository } from "@/src/modules/collaboration/application/meeting-contracts";
import type { MeetingMinutes, MeetingRecord } from "@/src/modules/collaboration/domain/meeting";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : asText(value);
function json<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

function mapMeeting(row: Row): MeetingRecord {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), projectId: optionalText(row.project_id), title: asText(row.title),
    organizerId: asText(row.organizer_id), participantIds: json<string[]>(row.participant_ids),
    requiredConfirmerIds: json<string[]>(row.required_confirmer_ids), confirmedByIds: json<string[]>(row.confirmed_by_ids),
    startsAt: asText(row.starts_at), status: row.status as MeetingRecord["status"], draftMinutes: json<MeetingMinutes>(row.draft_minutes),
    confirmedMinutes: row.confirmed_minutes == null ? undefined : json<MeetingMinutes>(row.confirmed_minutes),
    outcomeStatus: row.outcome_status as MeetingRecord["outcomeStatus"], confirmedAt: optionalText(row.confirmed_at), version: Number(row.version),
  };
}

export class PostgresMeetingRepository implements MeetingRepository {
  constructor(private readonly database: TransactionalDatabase) {}
  async getMeeting(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM meeting_records WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapMeeting(rows[0]) : null;
    });
  }
  async saveMeeting(meeting: MeetingRecord, expectedVersion?: number): Promise<boolean> {
    return this.database.withTenant(meeting.tenantId, async (executor) => {
      const params = [meeting.id,meeting.tenantId,meeting.projectId ?? null,meeting.title,meeting.organizerId,meeting.participantIds,meeting.requiredConfirmerIds,meeting.confirmedByIds,meeting.startsAt,meeting.status,meeting.draftMinutes,meeting.confirmedMinutes ?? null,meeting.outcomeStatus,meeting.confirmedAt ?? null,meeting.version];
      if (expectedVersion === undefined) {
        const rows = await executor.query(
          `INSERT INTO meeting_records(id,tenant_id,project_id,title,organizer_id,participant_ids,required_confirmer_ids,confirmed_by_ids,starts_at,status,draft_minutes,confirmed_minutes,outcome_status,confirmed_at,version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING RETURNING id`, params,
        );
        return rows.length === 1;
      }
      const rows = await executor.query(
        `UPDATE meeting_records SET project_id=$3,title=$4,participant_ids=$5,required_confirmer_ids=$6,confirmed_by_ids=$7,starts_at=$8,status=$9,draft_minutes=$10,confirmed_minutes=$11,outcome_status=$12,confirmed_at=$13,version=$14,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND version=$15 RETURNING id`,
        [meeting.id,meeting.tenantId,meeting.projectId ?? null,meeting.title,meeting.participantIds,meeting.requiredConfirmerIds,meeting.confirmedByIds,meeting.startsAt,meeting.status,meeting.draftMinutes,meeting.confirmedMinutes ?? null,meeting.outcomeStatus,meeting.confirmedAt ?? null,meeting.version,expectedVersion],
      );
      return rows.length === 1;
    });
  }
  async listMeetings(tenantId: string, actorId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        "SELECT * FROM meeting_records WHERE tenant_id=$1 AND (organizer_id=$2 OR participant_ids @> $3::jsonb) ORDER BY starts_at DESC LIMIT 50",
        [tenantId,actorId,[actorId]],
      );
      return rows.map(mapMeeting);
    });
  }
}
