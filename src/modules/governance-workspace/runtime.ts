import { MeetingService } from "@/src/modules/collaboration/application/meeting-service";
import { getDevelopmentMeetingRepository } from "@/src/modules/collaboration/infrastructure/in-memory-meeting-repository";
import { PostgresMeetingRepository } from "@/src/modules/collaboration/infrastructure/postgres-meeting-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { getDevelopmentKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/in-memory-repository";
import { PostgresKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/postgres-repository";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { WorkflowService } from "@/src/modules/workflow/application/service";
import { getDevelopmentWorkflowRepository } from "@/src/modules/workflow/infrastructure/in-memory-repository";
import { PostgresWorkflowRepository } from "@/src/modules/workflow/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

type GovernanceRuntime = {
  workflow: WorkflowService;
  knowledge: KnowledgeService;
  meetings: MeetingService;
};

const globalRuntime = globalThis as typeof globalThis & { __nexusGovernanceRuntime?: GovernanceRuntime; __nexusGovernanceRuntimeVersion?: number };

export function getGovernanceRuntime(): GovernanceRuntime {
  if (globalRuntime.__nexusGovernanceRuntimeVersion !== 1) {
    globalRuntime.__nexusGovernanceRuntime = undefined;
    globalRuntime.__nexusGovernanceRuntimeVersion = 1;
  }
  if (!globalRuntime.__nexusGovernanceRuntime) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      const knowledge = new KnowledgeService(new PostgresKnowledgeRepository(database));
      globalRuntime.__nexusGovernanceRuntime = {
        workflow: new WorkflowService(new PostgresWorkflowRepository(database), new PostgresEventStore(database)),
        knowledge,
        meetings: new MeetingService(new PostgresMeetingRepository(database), getManagementLoopService(), knowledge, new PostgresEventStore(database)),
      };
    } else {
      const events = new InMemoryEventStore();
      const knowledge = new KnowledgeService(getDevelopmentKnowledgeRepository());
      globalRuntime.__nexusGovernanceRuntime = {
        workflow: new WorkflowService(getDevelopmentWorkflowRepository(), events),
        knowledge,
        meetings: new MeetingService(getDevelopmentMeetingRepository(), getManagementLoopService(), knowledge, events),
      };
    }
  }
  return globalRuntime.__nexusGovernanceRuntime;
}
