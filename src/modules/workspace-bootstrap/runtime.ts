import { WorkspaceBootstrapService } from "@/src/modules/workspace-bootstrap/application/service";
import { InMemoryWorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/infrastructure/in-memory-repository";
import { PostgresWorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const runtime = globalThis as typeof globalThis & {
  __nexusWorkspaceBootstrapService?: WorkspaceBootstrapService;
  __nexusWorkspaceBootstrapVersion?: number;
};

export function getWorkspaceBootstrapService() {
  if (runtime.__nexusWorkspaceBootstrapVersion !== 1) {
    runtime.__nexusWorkspaceBootstrapService = undefined;
    runtime.__nexusWorkspaceBootstrapVersion = 1;
  }
  runtime.__nexusWorkspaceBootstrapService ??= process.env.DATABASE_URL
    ? new WorkspaceBootstrapService(new PostgresWorkspaceBootstrapRepository(createPostgresDatabase(process.env.DATABASE_URL)), "production")
    : new WorkspaceBootstrapService(new InMemoryWorkspaceBootstrapRepository(), "development_fixture");
  return runtime.__nexusWorkspaceBootstrapService;
}
