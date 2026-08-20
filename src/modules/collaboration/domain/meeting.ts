export type MeetingActionProposal = {
  title: string;
  ownerId: string;
  dueAt: string;
  acceptanceCriteria: string;
};

export type MeetingDecisionProposal = {
  topic: string;
  context: string;
  options: string[];
  selectedOption: string;
  rationale: string;
  actionItems: MeetingActionProposal[];
};

export type MeetingMinutes = {
  discussions: string[];
  conclusions: string[];
  decisions: MeetingDecisionProposal[];
  openQuestions: string[];
};

export type MeetingRecord = {
  id: string;
  tenantId: string;
  projectId?: string;
  title: string;
  organizerId: string;
  participantIds: string[];
  requiredConfirmerIds: string[];
  confirmedByIds: string[];
  startsAt: string;
  status: "draft" | "pending_confirmation" | "confirmed" | "cancelled";
  draftMinutes: MeetingMinutes;
  confirmedMinutes?: MeetingMinutes;
  outcomeStatus: "not_ready" | "pending" | "materialized";
  confirmedAt?: string;
  version: number;
};

export function confirmMeetingRecord(meeting: MeetingRecord, actorId: string, now = new Date()): MeetingRecord {
  if (meeting.status === "cancelled" || meeting.status === "draft") throw new Error("MEETING_INVALID_TRANSITION");
  if (!meeting.requiredConfirmerIds.includes(actorId)) throw new Error("MEETING_CONFIRMATION_NOT_REQUIRED");
  if (meeting.confirmedByIds.includes(actorId)) return meeting;
  const confirmedByIds = [...meeting.confirmedByIds, actorId];
  const completed = meeting.requiredConfirmerIds.every((id) => confirmedByIds.includes(id));
  return {
    ...meeting,
    confirmedByIds,
    ...(completed ? {
      status: "confirmed" as const,
      confirmedMinutes: structuredClone(meeting.draftMinutes),
      outcomeStatus: "pending" as const,
      confirmedAt: now.toISOString(),
    } : {}),
    version: meeting.version + 1,
  };
}
