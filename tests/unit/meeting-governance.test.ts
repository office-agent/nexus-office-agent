// Requirements: PR-002, PR-005, PR-006, MR-021, MR-022, MR-023, MR-024, MR-025, AC-002
import { describe, expect, it } from "vitest";
import { MeetingService } from "@/src/modules/collaboration/application/meeting-service";
import { InMemoryMeetingRepository, DEMO_MEETING_ID } from "@/src/modules/collaboration/infrastructure/in-memory-meeting-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { InMemoryKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/in-memory-repository";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { InMemoryManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

function fixture() {
  const events = new InMemoryEventStore();
  const managementRepository = new InMemoryManagementLoopRepository();
  const meetingRepository = new InMemoryMeetingRepository();
  const service = new MeetingService(
    meetingRepository,
    new ManagementLoopService(managementRepository, events),
    new KnowledgeService(new InMemoryKnowledgeRepository()),
    events,
  );
  return { service, managementRepository, meetingRepository, events };
}

describe("meeting governance", () => {
  it("prepares a cited fact pack without mutating the meeting", async () => {
    const { service, meetingRepository } = fixture();
    const context = createDevelopmentRequestContext();
    const before = await meetingRepository.getMeeting(context.tenantId, DEMO_MEETING_ID);
    const prepared = await service.prepare(context, DEMO_MEETING_ID);
    const after = await meetingRepository.getMeeting(context.tenantId, DEMO_MEETING_ID);
    expect(prepared.stateChanged).toBe(false);
    expect(prepared.citations[0]?.title).toBe("客户数据安全分级制度");
    expect(after).toEqual(before);
  });

  it("materializes confirmed decisions and action items exactly once", async () => {
    const { service, managementRepository } = fixture();
    const context = createDevelopmentRequestContext();
    const result = await service.confirm(context, DEMO_MEETING_ID, 1);
    expect(result.meeting.status).toBe("confirmed");
    expect(result.meeting.outcomeStatus).toBe("materialized");
    const first = await managementRepository.getSnapshot(context.tenantId, DEMO_PROJECT_ID);
    expect(first?.decisions).toHaveLength(1);
    expect(first?.actionItems).toHaveLength(1);
    await service.confirm(context, DEMO_MEETING_ID, result.meeting.version);
    const repeated = await managementRepository.getSnapshot(context.tenantId, DEMO_PROJECT_ID);
    expect(repeated?.decisions).toHaveLength(1);
    expect(repeated?.actionItems).toHaveLength(1);
  });

  it("rejects confirmation by someone who is not a required confirmer", async () => {
    const { service } = fixture();
    const context = { ...createDevelopmentRequestContext(), actorId: "10000000-0000-4000-8000-000000000009" };
    await expect(service.confirm(context, DEMO_MEETING_ID, 1)).rejects.toThrow("MEETING_CONFIRMATION_NOT_REQUIRED");
  });
});
