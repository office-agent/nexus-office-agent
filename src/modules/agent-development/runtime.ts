import { AgentDevelopmentService } from "@/src/modules/agent-development/application/service";
import { InMemoryAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/in-memory-store";
import { PostgresAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/postgres-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & { __nexusAgentDevelopmentService?: AgentDevelopmentService; __nexusAgentDevelopmentRuntimeVersion?: number };

export function getAgentDevelopmentService(): AgentDevelopmentService {
  if (runtime.__nexusAgentDevelopmentRuntimeVersion !== 1 || !runtime.__nexusAgentDevelopmentService) {
    const database = process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined;
    runtime.__nexusAgentDevelopmentService = new AgentDevelopmentService(database ? new PostgresAgentDevelopmentStore(database) : new InMemoryAgentDevelopmentStore());
    runtime.__nexusAgentDevelopmentRuntimeVersion = 1;
  }
  return runtime.__nexusAgentDevelopmentService;
}
