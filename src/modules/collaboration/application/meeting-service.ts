import { createHash } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { EventStore } from "@/src/modules/events/application/event-store";
import { createDomainEvent } from "@/src/modules/events/domain/event-envelope";
import type { KnowledgeService } from "@/src/modules/knowledge/application/service";
import type { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { MeetingRepository } from "@/src/modules/collaboration/application/meeting-contracts";
import { confirmMeetingRecord, type MeetingRecord } from "@/src/modules/collaboration/domain/meeting";

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function requireAllowed(context: RequestContext, action: "read" | "approve", meeting: MeetingRecord) {
  const decision = evaluateAccess({
    context, action, resource: {
      tenantId: meeting.tenantId, type: "meeting", id: meeting.id,
      ownerId: meeting.organizerId, projectId: meeting.projectId, state: meeting.status,
    },
  });
  if (!decision.allowed) throw new Error(`POLICY_DENIED:${decision.reason}`);
}

export class MeetingService {
  constructor(
    private readonly repository: MeetingRepository,
    private readonly management: ManagementLoopService,
    private readonly knowledge: KnowledgeService,
    private readonly events: EventStore,
  ) {}

  async list(context: RequestContext) {
    const meetings = await this.repository.listMeetings(context.tenantId, context.actorId);
    return meetings.filter((meeting) => {
      try { requireAllowed(context, "read", meeting); return true; } catch { return false; }
    });
  }

  async prepare(context: RequestContext, meetingId: string) {
    const meeting = await this.repository.getMeeting(context.tenantId, meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND");
    requireAllowed(context, "read", meeting);
    const citations = await this.knowledge.search(context, `${meeting.title} ${meeting.draftMinutes.openQuestions.join(" ")}`, { forAgent: true, limit: 5 });
    return {
      meetingId: meeting.id,
      agenda: ["确认议题和决策边界", ...meeting.draftMinutes.openQuestions.map((question) => `待澄清：${question}`), "确认决定、Owner 与验收标准"],
      evidenceGaps: citations.length ? [] : ["当前权限范围内没有找到可引用制度或历史材料"],
      citations,
      stateChanged: false as const,
    };
  }

  async confirm(context: RequestContext, meetingId: string, expectedVersion: number) {
    let meeting = await this.repository.getMeeting(context.tenantId, meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND");
    requireAllowed(context, "approve", meeting);

    if (meeting.status === "confirmed" && meeting.outcomeStatus === "materialized") {
      return { meeting, decisionIds: this.decisionIds(meeting) };
    }
    if (meeting.status !== "confirmed") {
      if (meeting.version !== expectedVersion) throw new Error("MEETING_VERSION_CONFLICT");
      const confirmed = confirmMeetingRecord(meeting, context.actorId);
      if (confirmed === meeting) return { meeting, decisionIds: [] };
      if (!(await this.repository.saveMeeting(confirmed, meeting.version))) throw new Error("MEETING_VERSION_CONFLICT");
      meeting = confirmed;
      if (meeting.status !== "confirmed") return { meeting, decisionIds: [] };
    }

    const materializingMeeting = meeting;
    const decisionIds: string[] = [];
    if (!materializingMeeting.projectId && materializingMeeting.confirmedMinutes?.decisions.length) throw new Error("MEETING_PROJECT_REQUIRED");
    for (const [decisionIndex, proposal] of (materializingMeeting.confirmedMinutes?.decisions ?? []).entries()) {
      const decisionId = stableUuid(`${materializingMeeting.id}:decision:${decisionIndex}`);
      decisionIds.push(decisionId);
      await this.management.recordDecision(context, {
        decisionId,
        projectId: materializingMeeting.projectId!,
        sourceMeetingId: materializingMeeting.id,
        title: proposal.topic,
        decisionContext: proposal.context,
        options: proposal.options,
        selectedOption: proposal.selectedOption,
        rationale: proposal.rationale,
        actionItems: proposal.actionItems.map((item, actionIndex) => ({
          ...item,
          id: stableUuid(`${materializingMeeting.id}:decision:${decisionIndex}:action:${actionIndex}`),
        })),
      });
    }
    const latest = await this.repository.getMeeting(context.tenantId, materializingMeeting.id);
    if (!latest) throw new Error("MEETING_NOT_FOUND");
    if (latest.outcomeStatus !== "materialized") {
      const materialized = { ...latest, outcomeStatus: "materialized" as const, version: latest.version + 1 };
      if (!(await this.repository.saveMeeting(materialized, latest.version))) throw new Error("MEETING_VERSION_CONFLICT");
      meeting = materialized;
    } else meeting = latest;
    await this.events.appendOutbox(createDomainEvent({
      type: "meeting.record_confirmed", version: 1, tenantId: context.tenantId,
      aggregateType: "meeting", aggregateId: meeting.id, aggregateVersion: meeting.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { projectId: meeting.projectId, decisionIds },
    }));
    return { meeting, decisionIds };
  }

  private decisionIds(meeting: MeetingRecord) {
    return (meeting.confirmedMinutes?.decisions ?? []).map((_, index) => stableUuid(`${meeting.id}:decision:${index}`));
  }
}
