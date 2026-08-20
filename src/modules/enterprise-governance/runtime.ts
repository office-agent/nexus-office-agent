import { EnterpriseGovernanceService } from "@/src/modules/enterprise-governance/application/service";
import { getDevelopmentEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/in-memory-repository";
import { PostgresEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & { __nexusGovernanceService?: EnterpriseGovernanceService; __nexusGovernanceServiceVersion?: number };

export function getEnterpriseGovernanceService() {
  if (runtime.__nexusGovernanceServiceVersion !== 1) {
    runtime.__nexusGovernanceService = undefined;
    runtime.__nexusGovernanceServiceVersion = 1;
  }
  if (!runtime.__nexusGovernanceService) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      runtime.__nexusGovernanceService = new EnterpriseGovernanceService(new PostgresEnterpriseGovernanceRepository(database), new PostgresEventStore(database));
    } else {
      runtime.__nexusGovernanceService = new EnterpriseGovernanceService(getDevelopmentEnterpriseGovernanceRepository(), new InMemoryEventStore());
    }
  }
  return runtime.__nexusGovernanceService;
}
