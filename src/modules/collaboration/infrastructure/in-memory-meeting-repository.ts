import type { MeetingRepository } from "@/src/modules/collaboration/application/meeting-contracts";
import type { MeetingRecord } from "@/src/modules/collaboration/domain/meeting";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_MEETING_ID = "84000000-0000-4000-8000-000000000001";

export class InMemoryMeetingRepository implements MeetingRepository {
  private readonly meetings = new Map<string, MeetingRecord>();
  constructor(seed = true) { if (seed) this.seed(); }

  async getMeeting(tenantId: string, id: string): Promise<MeetingRecord | null> {
    const meeting = this.meetings.get(id);
    return meeting?.tenantId === tenantId ? structuredClone(meeting) : null;
  }

  async saveMeeting(meeting: MeetingRecord, expectedVersion?: number): Promise<boolean> {
    const current = this.meetings.get(meeting.id);
    if (expectedVersion !== undefined && current?.version !== expectedVersion) return false;
    if (current && current.tenantId !== meeting.tenantId) return false;
    this.meetings.set(meeting.id, structuredClone(meeting));
    return true;
  }

  async listMeetings(tenantId: string, actorId: string): Promise<MeetingRecord[]> {
    return [...this.meetings.values()]
      .filter((meeting) => meeting.tenantId === tenantId && (meeting.organizerId === actorId || meeting.participantIds.includes(actorId)))
      .map((meeting) => structuredClone(meeting));
  }

  private seed() {
    const meeting: MeetingRecord = {
      id: DEMO_MEETING_ID, tenantId: DEMO_TENANT_ID, projectId: DEMO_PROJECT_ID,
      title: "华东交付风险决策会", organizerId: DEMO_MANAGER_ID,
      participantIds: [DEMO_MANAGER_ID], requiredConfirmerIds: [DEMO_MANAGER_ID], confirmedByIds: [],
      startsAt: "2026-08-05T03:00:00.000Z", status: "pending_confirmation",
      draftMinutes: {
        discussions: ["客户验收窗口与当前联调进度存在冲突。"],
        conclusions: ["将首批灰度范围控制在 30%，并优先保障核心业务链路。"],
        decisions: [{
          topic: "华东客户灰度范围", context: "接口联调晚于基线 2 天，完整放量风险不可接受。",
          options: ["按原计划全量", "30% 灰度", "延期上线"], selectedOption: "30% 灰度",
          rationale: "在保留上线窗口的同时限制影响面，并以 48 小时稳定性作为继续放量条件。",
          actionItems: [{
            title: "确认客户验收人与 30% 灰度窗口", ownerId: DEMO_MANAGER_ID,
            dueAt: "2026-08-06T03:00:00.000Z", acceptanceCriteria: "客户书面确认验收人、时间窗和灰度范围。",
          }],
        }],
        openQuestions: ["客户数据导出是否需要安全负责人会签？"],
      },
      outcomeStatus: "not_ready", version: 1,
    };
    this.meetings.set(meeting.id, meeting);
  }
}

const runtime = globalThis as typeof globalThis & { __nexusMeetingRepository?: InMemoryMeetingRepository; __nexusMeetingRepositoryVersion?: number };
export function getDevelopmentMeetingRepository() {
  if (runtime.__nexusMeetingRepositoryVersion !== 1) {
    runtime.__nexusMeetingRepository = new InMemoryMeetingRepository();
    runtime.__nexusMeetingRepositoryVersion = 1;
  }
  return runtime.__nexusMeetingRepository!;
}
