import { EnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/application/service";
import { getDevelopmentEnterpriseRepository } from "@/src/modules/enterprise-intelligence/infrastructure/in-memory-repository";
import { PostgresEnterpriseIntelligenceRepository } from "@/src/modules/enterprise-intelligence/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & { __nexusEnterpriseService?: EnterpriseIntelligenceService; __nexusEnterpriseServiceVersion?: number };

export function getEnterpriseIntelligenceService() {
  if (runtime.__nexusEnterpriseServiceVersion !== 1) {
    runtime.__nexusEnterpriseService = undefined;
    runtime.__nexusEnterpriseServiceVersion = 1;
  }
  if (!runtime.__nexusEnterpriseService) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      runtime.__nexusEnterpriseService = new EnterpriseIntelligenceService(new PostgresEnterpriseIntelligenceRepository(database), new PostgresEventStore(database));
    } else {
      runtime.__nexusEnterpriseService = new EnterpriseIntelligenceService(getDevelopmentEnterpriseRepository(), new InMemoryEventStore());
    }
  }
  return runtime.__nexusEnterpriseService;
}
