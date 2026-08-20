import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { WorkspaceBootstrap, WorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/application/contracts";

export class WorkspaceBootstrapService {
  constructor(
    private readonly repository: WorkspaceBootstrapRepository,
    private readonly dataMode: WorkspaceBootstrap["dataMode"],
  ) {}

  async bootstrap(context: RequestContext): Promise<WorkspaceBootstrap> {
    const identity = await this.repository.getIdentity(context.tenantId, context.actorId);
    if (!identity) throw new Error("WORKSPACE_IDENTITY_NOT_FOUND");

    const projects = (await this.repository.listProjects(context.tenantId)).filter((project) => evaluateAccess({
      context,
      action: "read",
      resource: {
        tenantId: context.tenantId,
        type: "project",
        id: project.id,
        projectId: project.id,
        ownerId: project.ownerId,
      },
    }).allowed);

    const selected = projects.find(({ status }) => status === "active") ?? projects[0] ?? null;
    return {
      identity: {
        ...identity,
        roles: [...context.roles],
        channel: context.channel,
      },
      projects,
      selectedProjectId: selected?.id ?? null,
      dataMode: this.dataMode,
      generatedAt: new Date().toISOString(),
    };
  }
}
