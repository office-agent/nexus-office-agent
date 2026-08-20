import { IntegrationAcceptanceService } from "@/src/modules/integration/application/acceptance";
import { TestNotificationService } from "@/src/modules/integration/application/test-notification";
import { WecomAccessControlService } from "@/src/modules/integration/application/wecom-access-control";
import { WecomApplicationMessageService } from "@/src/modules/integration/application/wecom-application-message";
import { createRuntimeConnectorAcceptanceProbe, createRuntimeIdentityAcceptanceProbe } from "@/src/modules/integration/infrastructure/acceptance-probes";
import { getDevelopmentAcceptanceRepository, PostgresAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { createRuntimeTestNotificationGateway } from "@/src/modules/integration/infrastructure/test-notification-gateway";
import { getDevelopmentTestNotificationProposalRepository, PostgresTestNotificationProposalRepository } from "@/src/modules/integration/infrastructure/test-notification-repository";
import { RuntimeWecomAppControlGateway } from "@/src/modules/integration/infrastructure/wecom-app-control-gateway";
import { RuntimeWecomApplicationMessageGateway } from "@/src/modules/integration/infrastructure/wecom-application-message-gateway";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & {
  __nexusIntegrationAcceptanceService?: IntegrationAcceptanceService;
  __nexusIntegrationAcceptanceServiceVersion?: number;
  __nexusTestNotificationService?: TestNotificationService;
  __nexusTestNotificationServiceVersion?: number;
  __nexusWecomAccessControlService?: WecomAccessControlService;
  __nexusWecomAccessControlServiceVersion?: number;
  __nexusWecomApplicationMessageService?: WecomApplicationMessageService;
  __nexusWecomApplicationMessageServiceVersion?: number;
};

export function getIntegrationAcceptanceService(): IntegrationAcceptanceService {
  if (runtime.__nexusIntegrationAcceptanceServiceVersion !== 2) {
    runtime.__nexusIntegrationAcceptanceService = undefined;
    runtime.__nexusIntegrationAcceptanceServiceVersion = 2;
  }
  if (!runtime.__nexusIntegrationAcceptanceService) {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    runtime.__nexusIntegrationAcceptanceService = new IntegrationAcceptanceService(
      repository,
      createRuntimeIdentityAcceptanceProbe(),
      createRuntimeConnectorAcceptanceProbe(),
    );
  }
  return runtime.__nexusIntegrationAcceptanceService;
}

export function getWecomApplicationMessageService(): WecomApplicationMessageService {
  if (runtime.__nexusWecomApplicationMessageServiceVersion !== 1) {
    runtime.__nexusWecomApplicationMessageService = undefined;
    runtime.__nexusWecomApplicationMessageServiceVersion = 1;
  }
  if (!runtime.__nexusWecomApplicationMessageService) {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    runtime.__nexusWecomApplicationMessageService = new WecomApplicationMessageService(
      repository,
      new RuntimeWecomApplicationMessageGateway(),
    );
  }
  return runtime.__nexusWecomApplicationMessageService;
}

export function getTestNotificationService(): TestNotificationService {
  if (runtime.__nexusTestNotificationServiceVersion !== 1) {
    runtime.__nexusTestNotificationService = undefined;
    runtime.__nexusTestNotificationServiceVersion = 1;
  }
  if (!runtime.__nexusTestNotificationService) {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      runtime.__nexusTestNotificationService = new TestNotificationService(
        new PostgresAcceptanceRepository(database),
        new PostgresTestNotificationProposalRepository(database),
        createRuntimeTestNotificationGateway(database),
      );
    } else {
      runtime.__nexusTestNotificationService = new TestNotificationService(
        getDevelopmentAcceptanceRepository(),
        getDevelopmentTestNotificationProposalRepository(),
        createRuntimeTestNotificationGateway(),
      );
    }
  }
  return runtime.__nexusTestNotificationService;
}

export function getWecomAccessControlService(): WecomAccessControlService {
  if (runtime.__nexusWecomAccessControlServiceVersion !== 1) {
    runtime.__nexusWecomAccessControlService = undefined;
    runtime.__nexusWecomAccessControlServiceVersion = 1;
  }
  if (!runtime.__nexusWecomAccessControlService) {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    runtime.__nexusWecomAccessControlService = new WecomAccessControlService(
      repository,
      new RuntimeWecomAppControlGateway(),
    );
  }
  return runtime.__nexusWecomAccessControlService;
}
