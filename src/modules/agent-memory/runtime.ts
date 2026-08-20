import { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { getDevelopmentAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/in-memory-repository";
import { PostgresAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & { __nexusAgentMemoryService?: AgentMemoryService; __nexusAgentMemoryRuntimeVersion?: number };

export function getAgentMemoryService(): AgentMemoryService {
  if (runtime.__nexusAgentMemoryRuntimeVersion !== 1) {
    const repository = process.env.DATABASE_URL
      ? new PostgresAgentMemoryRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAgentMemoryRepository();
    runtime.__nexusAgentMemoryService = new AgentMemoryService(repository);
    runtime.__nexusAgentMemoryRuntimeVersion = 1;
  }
  return runtime.__nexusAgentMemoryService!;
}
