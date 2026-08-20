import type { MeetingRecord } from "@/src/modules/collaboration/domain/meeting";

export interface MeetingRepository {
  getMeeting(tenantId: string, id: string): Promise<MeetingRecord | null>;
  saveMeeting(meeting: MeetingRecord, expectedVersion?: number): Promise<boolean>;
  listMeetings(tenantId: string, actorId: string): Promise<MeetingRecord[]>;
}
