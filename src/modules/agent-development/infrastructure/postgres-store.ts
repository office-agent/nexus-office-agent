import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
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
  ProjectToActDocumentKind,
} from "@/src/modules/agent-development/domain/contracts";

type ProjectRow = Record<string, unknown> & {
  id: string; tenant_id: string; created_by: string; code: string; name: string; owner_name: string; objective: string;
  scope: unknown; non_goals: unknown; acceptance_criteria: unknown; status: AgentDevelopmentStatus; input_digest: string;
  version: number; created_at: string | Date; updated_at: string | Date;
};
type DocumentRow = Record<string, unknown> & { id: string; project_id: string; kind: ProjectToActDocumentKind; path: string; revision: number; content: string; digest: string; archived_at: string | Date };
type VersionRow = Record<string, unknown> & { id: string; project_id: string; name: string; from_commit: string; to_commit: string; diff_content: string; diff_digest: string; features: unknown; created_by: string; created_at: string | Date };
type TestRow = Record<string, unknown> & { id: string; project_id: string; version_id: string; name: string; cases: unknown; result: "passed" | "failed"; evidence: string; evidence_digest: string; created_by: string; created_at: string | Date };
type DeliveryRow = Record<string, unknown> & { id: string; project_id: string; manifest_digest: string; document_digests: unknown; version_ids: unknown; test_ids: unknown; created_by: string; created_at: string | Date };

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function json(value: unknown): string { return JSON.stringify(value); }
function parsed<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return (value as T) ?? fallback;
}

function mapDocument(row: DocumentRow): ProjectToActDocument { return { id: row.id, projectId: row.project_id, kind: row.kind, path: row.path, revision: Number(row.revision), content: row.content, digest: row.digest, archivedAt: iso(row.archived_at) }; }
function mapVersion(row: VersionRow): AgentDevelopmentVersion { return { id: row.id, projectId: row.project_id, name: row.name, fromCommit: row.from_commit, toCommit: row.to_commit, diffContent: row.diff_content, diffDigest: row.diff_digest, features: parsed<string[]>(row.features, []), createdBy: row.created_by, createdAt: iso(row.created_at) }; }
function mapTest(row: TestRow): AgentDevelopmentFunctionalTest { return { id: row.id, projectId: row.project_id, versionId: row.version_id, name: row.name, cases: parsed<string[]>(row.cases, []), result: row.result, evidence: row.evidence, evidenceDigest: row.evidence_digest, createdBy: row.created_by, createdAt: iso(row.created_at) }; }
function mapDelivery(row: DeliveryRow): AgentDevelopmentDelivery { return { id: row.id, projectId: row.project_id, manifestDigest: row.manifest_digest, documentDigests: parsed<AgentDevelopmentDelivery["documentDigests"]>(row.document_digests, { overview: "", progress: "", features: "", versions: "", acceptance: "" }), versionIds: parsed<string[]>(row.version_ids, []), testIds: parsed<string[]>(row.test_ids, []), createdBy: row.created_by, createdAt: iso(row.created_at) }; }

export class PostgresAgentDevelopmentStore implements AgentDevelopmentStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async list(context: RequestContext): Promise<AgentDevelopmentProject[]> {
    return this.database.withTenant(context.tenantId, async (executor) => {
      const rows = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE tenant_id=$1 ORDER BY updated_at DESC,id", [context.tenantId]);
      return Promise.all(rows.map((row) => this.load(executor, row)));
    });
  }

  async find(context: RequestContext, projectId: string): Promise<AgentDevelopmentProject | null> {
    return this.database.withTenant(context.tenantId, async (executor) => {
      const rows = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE tenant_id=$1 AND id=$2", [context.tenantId, projectId]);
      return rows[0] ? this.load(executor, rows[0]) : null;
    });
  }

  async findProjectByIdempotency(context: RequestContext, idempotencyKey: string): Promise<AgentDevelopmentProject | null> {
    return this.database.withTenant(context.tenantId, async (executor) => {
      const rows = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      return rows[0] ? this.load(executor, rows[0]) : null;
    });
  }

  async create(context: RequestContext, item: AgentDevelopmentProjectSeed, documents: ProjectToActDocument[], idempotencyKey: string): Promise<{ project: AgentDevelopmentProject; created: boolean }> {
    return this.database.withTenant(context.tenantId, async (executor) => {
      const existing = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      if (existing[0]) return { project: await this.load(executor, existing[0]), created: false };
      await executor.query(`INSERT INTO agent_development_projects(id,tenant_id,created_by,code,name,owner_name,objective,scope,non_goals,acceptance_criteria,status,input_digest,version,idempotency_key,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16)`, [item.id, item.tenantId, item.createdBy, item.code, item.name, item.owner, item.objective, json(item.scope), json(item.nonGoals), json(item.acceptanceCriteria), item.status, item.inputDigest, item.version, idempotencyKey, item.createdAt, item.updatedAt]);
      await this.insertDocuments(executor, context.tenantId, documents);
      const rows = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE id=$1", [item.id]);
      return { project: await this.load(executor, rows[0]), created: true };
    });
  }

  async appendVersion(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentVersion, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject> {
    await this.database.withTenant(context.tenantId, async (executor) => {
      const replay = await executor.query<VersionRow>("SELECT * FROM agent_development_versions WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      if (replay[0]) {
        const previous = mapVersion(replay[0]);
        if (previous.projectId !== projectId || previous.name !== item.name || previous.fromCommit !== item.fromCommit || previous.toCommit !== item.toCommit || previous.diffDigest !== item.diffDigest || previous.createdBy !== item.createdBy || json(previous.features) !== json(item.features)) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
        return;
      }
      if ((await executor.query("SELECT id FROM agent_development_versions WHERE tenant_id=$1 AND project_id=$2 AND name=$3", [context.tenantId, projectId, item.name])).length) throw new Error("AGENT_DEVELOPMENT_VERSION_NAME_CONFLICT");
      await this.lockProject(executor, context, projectId, expectedVersion);
      await executor.query(`INSERT INTO agent_development_versions(id,tenant_id,project_id,name,from_commit,to_commit,diff_content,diff_digest,features,created_by,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`, [item.id, context.tenantId, projectId, item.name, item.fromCommit, item.toCommit, item.diffContent, item.diffDigest, json(item.features), item.createdBy, idempotencyKey, item.createdAt]);
      await this.insertDocuments(executor, context.tenantId, documents);
      await this.advance(executor, context, projectId, expectedVersion, status, item.createdAt);
    });
    return (await this.find(context, projectId))!;
  }

  async appendTest(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentFunctionalTest, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject> {
    await this.database.withTenant(context.tenantId, async (executor) => {
      const replay = await executor.query<TestRow>("SELECT * FROM agent_development_tests WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      if (replay[0]) {
        const previous = mapTest(replay[0]);
        if (previous.projectId !== projectId || previous.versionId !== item.versionId || previous.name !== item.name || previous.result !== item.result || previous.evidenceDigest !== item.evidenceDigest || previous.createdBy !== item.createdBy || json(previous.cases) !== json(item.cases)) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
        return;
      }
      await this.lockProject(executor, context, projectId, expectedVersion);
      await executor.query(`INSERT INTO agent_development_tests(id,tenant_id,project_id,version_id,name,cases,result,evidence,evidence_digest,created_by,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`, [item.id, context.tenantId, projectId, item.versionId, item.name, json(item.cases), item.result, item.evidence, item.evidenceDigest, item.createdBy, idempotencyKey, item.createdAt]);
      await this.insertDocuments(executor, context.tenantId, documents);
      await this.advance(executor, context, projectId, expectedVersion, status, item.createdAt);
    });
    return (await this.find(context, projectId))!;
  }

  async createDelivery(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentDelivery, documents: ProjectToActDocument[], idempotencyKey: string): Promise<AgentDevelopmentProject> {
    await this.database.withTenant(context.tenantId, async (executor) => {
      const replay = await executor.query<DeliveryRow>("SELECT * FROM agent_development_deliveries WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      if (replay[0]) {
        const previous = mapDelivery(replay[0]);
        if (previous.projectId !== projectId || previous.manifestDigest !== item.manifestDigest || previous.createdBy !== item.createdBy) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
        return;
      }
      await this.lockProject(executor, context, projectId, expectedVersion);
      await executor.query(`INSERT INTO agent_development_deliveries(id,tenant_id,project_id,manifest_digest,document_digests,version_ids,test_ids,created_by,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)`, [item.id, context.tenantId, projectId, item.manifestDigest, json(item.documentDigests), json(item.versionIds), json(item.testIds), item.createdBy, idempotencyKey, item.createdAt]);
      await this.insertDocuments(executor, context.tenantId, documents);
      await this.advance(executor, context, projectId, expectedVersion, "delivered", item.createdAt);
    });
    return (await this.find(context, projectId))!;
  }

  private async lockProject(executor: DatabaseExecutor, context: RequestContext, projectId: string, expectedVersion: number): Promise<void> {
    const rows = await executor.query<ProjectRow>("SELECT * FROM agent_development_projects WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, projectId]);
    if (!rows[0]) throw new Error("AGENT_DEVELOPMENT_PROJECT_NOT_FOUND");
    if (Number(rows[0].version) !== expectedVersion) throw new Error("AGENT_DEVELOPMENT_VERSION_CONFLICT");
    if (rows[0].status === "delivered") throw new Error("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
  }

  private async advance(executor: DatabaseExecutor, context: RequestContext, projectId: string, expectedVersion: number, status: AgentDevelopmentStatus, updatedAt: string): Promise<void> {
    const rows = await executor.query("UPDATE agent_development_projects SET status=$1,version=version+1,updated_at=$2 WHERE tenant_id=$3 AND id=$4 AND version=$5 RETURNING id", [status, updatedAt, context.tenantId, projectId, expectedVersion]);
    if (!rows.length) throw new Error("AGENT_DEVELOPMENT_VERSION_CONFLICT");
  }

  private async insertDocuments(executor: DatabaseExecutor, tenantId: string, documents: ProjectToActDocument[]): Promise<void> {
    for (const item of documents) {
      await executor.query(`INSERT INTO agent_development_documents(id,tenant_id,project_id,kind,path,revision,content,digest,archived_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [item.id, tenantId, item.projectId, item.kind, item.path, item.revision, item.content, item.digest, item.archivedAt]);
    }
  }

  private async load(executor: DatabaseExecutor, row: ProjectRow): Promise<AgentDevelopmentProject> {
    const [documentRows, versionRows, testRows, deliveryRows] = await Promise.all([
      executor.query<DocumentRow>(`SELECT DISTINCT ON (kind) * FROM agent_development_documents WHERE project_id=$1 ORDER BY kind,revision DESC`, [row.id]),
      executor.query<VersionRow>("SELECT * FROM agent_development_versions WHERE project_id=$1 ORDER BY created_at,id", [row.id]),
      executor.query<TestRow>("SELECT * FROM agent_development_tests WHERE project_id=$1 ORDER BY created_at,id", [row.id]),
      executor.query<DeliveryRow>("SELECT * FROM agent_development_deliveries WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", [row.id]),
    ]);
    return {
      id: row.id, tenantId: row.tenant_id, createdBy: row.created_by, code: row.code, name: row.name, owner: row.owner_name, objective: row.objective,
      scope: parsed<string[]>(row.scope, []), nonGoals: parsed<string[]>(row.non_goals, []), acceptanceCriteria: parsed<string[]>(row.acceptance_criteria, []), status: row.status, inputDigest: row.input_digest,
      version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), documents: documentRows.map(mapDocument).sort((a, b) => a.path.localeCompare(b.path)),
      versions: versionRows.map(mapVersion), tests: testRows.map(mapTest), delivery: deliveryRows[0] ? mapDelivery(deliveryRows[0]) : undefined,
    };
  }
}
