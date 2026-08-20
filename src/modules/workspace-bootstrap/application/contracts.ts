export type WorkspaceIdentity = {
  tenantId: string;
  tenantName: string;
  actorId: string;
  displayName: string;
};

export type WorkspaceProject = {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  status: string;
  priority: string;
  health: string;
  targetEndAt: string;
};

export type WorkspaceBootstrap = {
  identity: WorkspaceIdentity & {
    roles: string[];
    channel: string;
  };
  projects: WorkspaceProject[];
  selectedProjectId: string | null;
  dataMode: "production" | "development_fixture";
  generatedAt: string;
};

export interface WorkspaceBootstrapRepository {
  getIdentity(tenantId: string, actorId: string): Promise<WorkspaceIdentity | null>;
  listProjects(tenantId: string): Promise<WorkspaceProject[]>;
}
