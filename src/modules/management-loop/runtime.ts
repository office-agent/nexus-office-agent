import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { getDevelopmentManagementRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & {
  __nexusManagementService?: ManagementLoopService;
  __nexusManagementRuntimeVersion?: number;
};

export function getManagementLoopService(): ManagementLoopService {
  if (runtime.__nexusManagementRuntimeVersion !== 4) {
    runtime.__nexusManagementService = undefined;
    runtime.__nexusManagementRuntimeVersion = 4;
  }
  if (!runtime.__nexusManagementService) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      runtime.__nexusManagementService = new ManagementLoopService(new PostgresManagementLoopRepository(database));
    } else {
      runtime.__nexusManagementService = new ManagementLoopService(getDevelopmentManagementRepository());
    }
  }
  return runtime.__nexusManagementService;
}
