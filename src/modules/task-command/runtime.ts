import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { getDevelopmentTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & { __nexusTaskCommandService?: TaskCommandService; __nexusTaskCommandRuntimeVersion?: number };

export function getTaskCommandService() {
  if (runtime.__nexusTaskCommandRuntimeVersion !== 4) {
    const repository = process.env.DATABASE_URL
      ? new PostgresTaskCommandRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentTaskCommandRepository();
    runtime.__nexusTaskCommandService = new TaskCommandService(repository);
    runtime.__nexusTaskCommandRuntimeVersion = 4;
  }
  return runtime.__nexusTaskCommandService!;
}
