import type { WorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/application/contracts";
import { getDevelopmentManagementRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export class InMemoryWorkspaceBootstrapRepository implements WorkspaceBootstrapRepository {
  async getIdentity(tenantId: string, actorId: string) {
    if (tenantId !== DEMO_TENANT_ID || actorId !== DEMO_MANAGER_ID) return null;
    return {
      tenantId,
      tenantName: "本地开发工作区",
      actorId,
      displayName: "开发管理员",
    };
  }

  async listProjects(tenantId: string) {
    const snapshot = await getDevelopmentManagementRepository().getSnapshot(tenantId, DEMO_PROJECT_ID);
    if (!snapshot) return [];
    const { project } = snapshot;
    return [{
      id: project.id,
      code: project.code,
      name: project.name,
      ownerId: project.ownerId,
      status: project.status,
      priority: project.priority,
      health: project.health,
      targetEndAt: project.targetEndAt,
    }];
  }
}
