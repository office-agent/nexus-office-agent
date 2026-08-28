import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  AgentDevelopmentDelivery,
  AgentDevelopmentFunctionalTest,
  AgentDevelopmentProject,
  AgentDevelopmentProjectSeed,
  AgentDevelopmentStatus,
  AgentDevelopmentStore,
  AgentDevelopmentVersion,
  ProjectToActDocument,
} from "@/src/modules/agent-development/domain/contracts";

function clone<T>(value: T): T { return structuredClone(value); }
function replayDigest(value: unknown): string { return JSON.stringify(value); }

export class InMemoryAgentDevelopmentStore implements AgentDevelopmentStore {
  private readonly projects = new Map<string, AgentDevelopmentProject>();
  private readonly projectKeys = new Map<string, string>();
  private readonly actionKeys = new Map<string, { projectId: string; digest: string }>();

  async list(context: RequestContext): Promise<AgentDevelopmentProject[]> {
    return [...this.projects.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone);
  }

  async find(context: RequestContext, projectId: string): Promise<AgentDevelopmentProject | null> {
    const item = this.projects.get(projectId);
    return item?.tenantId === context.tenantId ? clone(item) : null;
  }

  async findProjectByIdempotency(context: RequestContext, idempotencyKey: string): Promise<AgentDevelopmentProject | null> {
    const id = this.projectKeys.get(`${context.tenantId}:${idempotencyKey}`);
    return id ? this.find(context, id) : null;
  }

  async create(context: RequestContext, seed: AgentDevelopmentProjectSeed, documents: ProjectToActDocument[], idempotencyKey: string): Promise<{ project: AgentDevelopmentProject; created: boolean }> {
    const existing = await this.findProjectByIdempotency(context, idempotencyKey);
    if (existing) return { project: existing, created: false };
    const project: AgentDevelopmentProject = { ...clone(seed), documents: clone(documents), versions: [], tests: [] };
    this.projects.set(project.id, project);
    this.projectKeys.set(`${context.tenantId}:${idempotencyKey}`, project.id);
    return { project: clone(project), created: true };
  }

  async appendVersion(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentVersion, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject> {
    const existingAction = this.actionKeys.get(`${context.tenantId}:version:${idempotencyKey}`);
    if (existingAction) {
      const actionDigest = replayDigest({ name: item.name, fromCommit: item.fromCommit, toCommit: item.toCommit, diffDigest: item.diffDigest, features: item.features, createdBy: item.createdBy });
      if (existingAction.projectId !== projectId || existingAction.digest !== actionDigest) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
      return this.require(context, projectId);
    }
    const project = this.requireMutable(context, projectId, expectedVersion);
    if (project.delivery) throw new Error("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
    if (project.versions.some((version) => version.name === item.name)) throw new Error("AGENT_DEVELOPMENT_VERSION_NAME_CONFLICT");
    project.versions.push(clone(item));
    project.documents = clone(documents);
    project.status = status;
    project.version += 1;
    project.updatedAt = item.createdAt;
    this.actionKeys.set(`${context.tenantId}:version:${idempotencyKey}`, { projectId, digest: replayDigest({ name: item.name, fromCommit: item.fromCommit, toCommit: item.toCommit, diffDigest: item.diffDigest, features: item.features, createdBy: item.createdBy }) });
    return clone(project);
  }

  async appendTest(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentFunctionalTest, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject> {
    const existingAction = this.actionKeys.get(`${context.tenantId}:test:${idempotencyKey}`);
    if (existingAction) {
      const actionDigest = replayDigest({ versionId: item.versionId, name: item.name, cases: item.cases, result: item.result, evidenceDigest: item.evidenceDigest, createdBy: item.createdBy });
      if (existingAction.projectId !== projectId || existingAction.digest !== actionDigest) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
      return this.require(context, projectId);
    }
    const project = this.requireMutable(context, projectId, expectedVersion);
    if (project.delivery) throw new Error("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
    project.tests.push(clone(item));
    project.documents = clone(documents);
    project.status = status;
    project.version += 1;
    project.updatedAt = item.createdAt;
    this.actionKeys.set(`${context.tenantId}:test:${idempotencyKey}`, { projectId, digest: replayDigest({ versionId: item.versionId, name: item.name, cases: item.cases, result: item.result, evidenceDigest: item.evidenceDigest, createdBy: item.createdBy }) });
    return clone(project);
  }

  async createDelivery(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentDelivery, documents: ProjectToActDocument[], idempotencyKey: string): Promise<AgentDevelopmentProject> {
    const existingAction = this.actionKeys.get(`${context.tenantId}:delivery:${idempotencyKey}`);
    if (existingAction) {
      if (existingAction.projectId !== projectId || existingAction.digest !== item.manifestDigest) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
      return this.require(context, projectId);
    }
    const project = this.requireMutable(context, projectId, expectedVersion);
    if (project.delivery) return clone(project);
    project.delivery = clone(item);
    project.documents = clone(documents);
    project.status = "delivered";
    project.version += 1;
    project.updatedAt = item.createdAt;
    this.actionKeys.set(`${context.tenantId}:delivery:${idempotencyKey}`, { projectId, digest: item.manifestDigest });
    return clone(project);
  }

  private require(context: RequestContext, projectId: string): AgentDevelopmentProject {
    const item = this.projects.get(projectId);
    if (!item || item.tenantId !== context.tenantId) throw new Error("AGENT_DEVELOPMENT_PROJECT_NOT_FOUND");
    return clone(item);
  }

  private requireMutable(context: RequestContext, projectId: string, expectedVersion: number): AgentDevelopmentProject {
    const item = this.projects.get(projectId);
    if (!item || item.tenantId !== context.tenantId) throw new Error("AGENT_DEVELOPMENT_PROJECT_NOT_FOUND");
    if (item.version !== expectedVersion) throw new Error("AGENT_DEVELOPMENT_VERSION_CONFLICT");
    return item;
  }
}
