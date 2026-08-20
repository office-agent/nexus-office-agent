import { InMemoryEventStore, type EventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { getDevelopmentManagementRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & {
  __nexusManagementEvents?: EventStore;
  __nexusManagementService?: ManagementLoopService;
  __nexusManagementRuntimeVersion?: number;
};

export function getManagementLoopService(): ManagementLoopService {
  if (runtime.__nexusManagementRuntimeVersion !== 3) {
    runtime.__nexusManagementEvents = new InMemoryEventStore();
    runtime.__nexusManagementService = undefined;
    runtime.__nexusManagementRuntimeVersion = 3;
  }
  if (!runtime.__nexusManagementService) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      runtime.__nexusManagementEvents = new PostgresEventStore(database);
      runtime.__nexusManagementService = new ManagementLoopService(new PostgresManagementLoopRepository(database), runtime.__nexusManagementEvents);
    } else {
      runtime.__nexusManagementEvents = new InMemoryEventStore();
      runtime.__nexusManagementService = new ManagementLoopService(getDevelopmentManagementRepository(), runtime.__nexusManagementEvents);
    }
  }
  return runtime.__nexusManagementService;
}
