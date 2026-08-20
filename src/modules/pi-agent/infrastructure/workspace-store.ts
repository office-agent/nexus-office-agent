import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiArtifactStatus,
  PiCredentialLeaseStatus,
  PiDownloadGrant,
  PiDownloadGrantStatus,
  PiGitCredentialLease,
  PiRepositoryBinding,
  PiWorkspaceArtifact,
  PiWorkspaceRecord,
  PiWorkspaceStatus,
  PiWorkspaceStore,
} from "@/src/modules/pi-agent/domain/workspace-contracts";

type Row = Record<string, unknown>;

const WORKSPACE_TRANSITIONS: Record<PiWorkspaceStatus, PiWorkspaceStatus[]> = {
  preparing: ["ready", "failed", "unknown", "destroying"],
  ready: ["checkpointing", "destroying", "failed", "unknown"],
  checkpointing: ["ready", "failed", "unknown"],
  destroying: ["destroyed", "failed", "unknown"],
  destroyed: [],
  failed: ["destroying", "destroyed", "unknown"],
  unknown: ["destroying", "destroyed"],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function assertWorkspaceTransition(from: PiWorkspaceStatus, to: PiWorkspaceStatus): void {
  if (from !== to && !WORKSPACE_TRANSITIONS[from].includes(to)) throw new Error("PI_WORKSPACE_STATE_CONFLICT");
}

function repositoryFromRow(row: Row): PiRepositoryBinding {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    provider: row.forge_type as PiRepositoryBinding["provider"],
    repositoryRef: String(row.repository_ref),
    defaultBranch: String(row.default_branch),
    credentialRef: String(row.credential_ref),
    status: row.status as PiRepositoryBinding["status"],
    createdAt: iso(row.created_at),
    updatedAt: optionalIso(row.updated_at),
  };
}

function workspaceFromRow(row: Row): PiWorkspaceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    sessionId: String(row.pi_session_id),
    runId: String(row.pi_run_id),
    workspaceId: String(row.workspace_id),
    repositoryId: String(row.repository_id),
    provider: row.provider as PiWorkspaceRecord["provider"],
    repositoryRef: String(row.repository_ref),
    baseRef: String(row.base_ref),
    baseCommitSha: String(row.base_commit_sha),
    ephemeralBranch: String(row.ephemeral_branch),
    status: row.status as PiWorkspaceStatus,
    providerWorkspaceRef: row.provider_workspace_ref ? String(row.provider_workspace_ref) : undefined,
    headCommitSha: row.head_commit_sha ? String(row.head_commit_sha) : undefined,
    workspaceDigest: row.workspace_digest ? String(row.workspace_digest) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    destroyedAt: optionalIso(row.destroyed_at),
  };
}

function leaseFromRow(row: Row): PiGitCredentialLease {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    workspaceId: String(row.pi_workspace_id),
    repositoryId: String(row.repository_id),
    branch: String(row.branch),
    scopeDigest: String(row.scope_digest),
    leaseRef: String(row.lease_ref),
    status: row.status as PiCredentialLeaseStatus,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    revokedAt: optionalIso(row.revoked_at),
  };
}

function artifactFromRow(row: Row): PiWorkspaceArtifact {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    sessionId: String(row.pi_session_id),
    runId: row.pi_run_id ? String(row.pi_run_id) : undefined,
    workspaceId: row.pi_workspace_id ? String(row.pi_workspace_id) : undefined,
    type: row.artifact_type as PiWorkspaceArtifact["type"],
    fileName: String(row.file_name),
    mediaType: String(row.media_type),
    storageRef: String(row.storage_ref),
    objectVersion: String(row.object_version),
    contentDigest: String(row.content_digest),
    sizeBytes: Number(row.size_bytes),
    classification: row.classification as PiWorkspaceArtifact["classification"],
    version: Number(row.version),
    status: row.status as PiArtifactStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: optionalIso(row.expires_at),
  };
}

function grantFromRow(row: Row): PiDownloadGrant {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    artifactId: String(row.artifact_id),
    artifactVersion: Number(row.artifact_version),
    grantRef: String(row.grant_ref),
    url: String(row.url),
    status: row.status as PiDownloadGrantStatus,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    revokedAt: optionalIso(row.revoked_at),
  };
}

export class InMemoryPiWorkspaceStore implements PiWorkspaceStore {
  private readonly repositories = new Map<string, PiRepositoryBinding>();
  private readonly workspaces = new Map<string, PiWorkspaceRecord>();
  private readonly leases = new Map<string, PiGitCredentialLease>();
  private readonly artifacts = new Map<string, PiWorkspaceArtifact>();
  private readonly grants = new Map<string, PiDownloadGrant>();

  async getRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding | null> {
    const repository = this.repositories.get(repositoryId);
    return repository && repository.tenantId === context.tenantId ? clone(repository) : null;
  }

  async putRepository(binding: PiRepositoryBinding): Promise<void> {
    if (this.repositories.has(binding.id)) throw new Error("PI_REPOSITORY_DUPLICATE");
    this.repositories.set(binding.id, clone(binding));
  }

  async createWorkspace(record: PiWorkspaceRecord): Promise<void> {
    if (this.workspaces.has(record.id) || [...this.workspaces.values()].some((item) => item.tenantId === record.tenantId && item.runId === record.runId)) {
      throw new Error("PI_WORKSPACE_DUPLICATE");
    }
    this.workspaces.set(record.id, clone(record));
  }

  async getWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord | null> {
    const record = this.workspaces.get(workspaceRecordId);
    return record && record.tenantId === context.tenantId && record.actorId === context.actorId ? clone(record) : null;
  }

  async getWorkspaceForRun(context: RequestContext, runId: string): Promise<PiWorkspaceRecord | null> {
    const record = [...this.workspaces.values()].find((item) => item.tenantId === context.tenantId && item.actorId === context.actorId && item.runId === runId);
    return record ? clone(record) : null;
  }

  async transitionWorkspace(
    context: RequestContext,
    workspaceRecordId: string,
    status: PiWorkspaceStatus,
    patch: Partial<Pick<PiWorkspaceRecord, "providerWorkspaceRef" | "headCommitSha" | "workspaceDigest" | "failureCode" | "updatedAt" | "destroyedAt">> = {},
  ): Promise<PiWorkspaceRecord> {
    const current = await this.getWorkspace(context, workspaceRecordId);
    if (!current) throw new Error("PI_WORKSPACE_NOT_FOUND");
    assertWorkspaceTransition(current.status, status);
    const updated = clone({ ...current, ...patch, status, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    this.workspaces.set(workspaceRecordId, updated);
    return clone(updated);
  }

  async listWorkspaces(context: RequestContext, sessionId: string): Promise<PiWorkspaceRecord[]> {
    return [...this.workspaces.values()]
      .filter((item) => item.tenantId === context.tenantId && item.actorId === context.actorId && item.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async createCredentialLease(lease: PiGitCredentialLease): Promise<void> {
    if (this.leases.has(lease.id) || [...this.leases.values()].some((item) => item.tenantId === lease.tenantId && item.leaseRef === lease.leaseRef)) {
      throw new Error("PI_CREDENTIAL_LEASE_DUPLICATE");
    }
    this.leases.set(lease.id, clone(lease));
  }

  async getCredentialLease(context: RequestContext, leaseId: string): Promise<PiGitCredentialLease | null> {
    const lease = this.leases.get(leaseId);
    return lease && lease.tenantId === context.tenantId && lease.actorId === context.actorId ? clone(lease) : null;
  }

  async getCredentialLeaseForWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiGitCredentialLease | null> {
    const lease = [...this.leases.values()]
      .filter((item) => item.tenantId === context.tenantId && item.actorId === context.actorId && item.workspaceId === workspaceRecordId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return lease ? clone(lease) : null;
  }

  async revokeCredentialLease(context: RequestContext, leaseId: string, now = new Date()): Promise<PiGitCredentialLease> {
    const lease = await this.getCredentialLease(context, leaseId);
    if (!lease) throw new Error("PI_CREDENTIAL_LEASE_NOT_FOUND");
    const updated = clone({ ...lease, status: "revoked" as const, revokedAt: now.toISOString() });
    this.leases.set(leaseId, updated);
    return clone(updated);
  }

  async createArtifact(artifact: PiWorkspaceArtifact): Promise<void> {
    const key = `${artifact.id}:${artifact.version}`;
    if (this.artifacts.has(key)) throw new Error("PI_ARTIFACT_DUPLICATE");
    this.artifacts.set(key, clone(artifact));
  }

  async getArtifact(context: RequestContext, artifactId: string, version?: number): Promise<PiWorkspaceArtifact | null> {
    const matches = [...this.artifacts.values()]
      .filter((item) => item.id === artifactId && item.tenantId === context.tenantId && item.actorId === context.actorId)
      .filter((item) => version === undefined || item.version === version)
      .sort((left, right) => right.version - left.version);
    return matches[0] ? clone(matches[0]) : null;
  }

  async listArtifacts(context: RequestContext, sessionId: string): Promise<PiWorkspaceArtifact[]> {
    return [...this.artifacts.values()]
      .filter((item) => item.tenantId === context.tenantId && item.actorId === context.actorId && item.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async expireArtifacts(context: RequestContext, now = new Date()): Promise<number> {
    let count = 0;
    for (const [key, artifact] of this.artifacts.entries()) {
      if (artifact.tenantId !== context.tenantId || artifact.actorId !== context.actorId || artifact.status !== "active" || !artifact.expiresAt || new Date(artifact.expiresAt) > now) continue;
      this.artifacts.set(key, clone({ ...artifact, status: "expired" as const, updatedAt: now.toISOString() }));
      count += 1;
    }
    return count;
  }

  async createDownloadGrant(grant: PiDownloadGrant): Promise<void> {
    if (this.grants.has(grant.id) || [...this.grants.values()].some((item) => item.tenantId === grant.tenantId && item.grantRef === grant.grantRef)) {
      throw new Error("PI_DOWNLOAD_GRANT_DUPLICATE");
    }
    this.grants.set(grant.id, clone(grant));
  }

  async getDownloadGrant(context: RequestContext, grantId: string): Promise<PiDownloadGrant | null> {
    const grant = this.grants.get(grantId);
    return grant && grant.tenantId === context.tenantId && grant.actorId === context.actorId ? clone(grant) : null;
  }

  async revokeDownloadGrant(context: RequestContext, grantId: string, now = new Date()): Promise<PiDownloadGrant> {
    const grant = await this.getDownloadGrant(context, grantId);
    if (!grant) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
    const updated = clone({ ...grant, status: "revoked" as const, revokedAt: now.toISOString() });
    this.grants.set(grantId, updated);
    return clone(updated);
  }
}

export class PostgresPiWorkspaceStore implements PiWorkspaceStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  async getRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM workspace_repositories WHERE tenant_id=$1 AND id=$2", [context.tenantId, repositoryId]);
      return rows[0] ? repositoryFromRow(rows[0]) : null;
    });
  }

  async putRepository(binding: PiRepositoryBinding): Promise<void> {
    const context: RequestContext = {
      tenantId: binding.tenantId,
      actorId: "00000000-0000-4000-8000-000000000000",
      sessionId: "system",
      channel: "system",
      traceId: binding.id,
      roles: ["system"],
      permissions: [],
      dataScopes: [{ type: "tenant" }],
    };
    await this.scoped(context, async (db) => {
      await db.query(
        `INSERT INTO workspace_repositories
          (id,tenant_id,workspace_id,forge_type,repository_ref,default_branch,credential_ref,status,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [binding.id, binding.tenantId, binding.workspaceId, binding.provider, binding.repositoryRef, binding.defaultBranch, binding.credentialRef, binding.status],
      );
    });
  }

  async createWorkspace(record: PiWorkspaceRecord): Promise<void> {
    const context = this.contextFor(record);
    await this.scoped(context, async (db) => {
      await db.query(
        `INSERT INTO pi_workspaces
          (id,tenant_id,actor_id,pi_session_id,pi_run_id,workspace_id,repository_id,provider,repository_ref,base_ref,base_commit_sha,
           ephemeral_branch,status,provider_workspace_ref,head_commit_sha,workspace_digest,failure_code,created_at,updated_at,destroyed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [record.id, record.tenantId, record.actorId, record.sessionId, record.runId, record.workspaceId, record.repositoryId, record.provider,
          record.repositoryRef, record.baseRef, record.baseCommitSha, record.ephemeralBranch, record.status, record.providerWorkspaceRef ?? null,
          record.headCommitSha ?? null, record.workspaceDigest ?? null, record.failureCode ?? null, new Date(record.createdAt), new Date(record.updatedAt),
          record.destroyedAt ? new Date(record.destroyedAt) : null],
      );
    });
  }

  async getWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_workspaces WHERE tenant_id=$1 AND actor_id=$2 AND id=$3", [context.tenantId, context.actorId, workspaceRecordId]);
      return rows[0] ? workspaceFromRow(rows[0]) : null;
    });
  }

  async getWorkspaceForRun(context: RequestContext, runId: string): Promise<PiWorkspaceRecord | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_workspaces WHERE tenant_id=$1 AND actor_id=$2 AND pi_run_id=$3", [context.tenantId, context.actorId, runId]);
      return rows[0] ? workspaceFromRow(rows[0]) : null;
    });
  }

  async transitionWorkspace(
    context: RequestContext,
    workspaceRecordId: string,
    status: PiWorkspaceStatus,
    patch: Partial<Pick<PiWorkspaceRecord, "providerWorkspaceRef" | "headCommitSha" | "workspaceDigest" | "failureCode" | "updatedAt" | "destroyedAt">> = {},
  ): Promise<PiWorkspaceRecord> {
    return this.scoped(context, async (db) => {
      const currentRows = await db.query<Row>("SELECT * FROM pi_workspaces WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE", [context.tenantId, context.actorId, workspaceRecordId]);
      if (!currentRows[0]) throw new Error("PI_WORKSPACE_NOT_FOUND");
      const current = workspaceFromRow(currentRows[0]);
      assertWorkspaceTransition(current.status, status);
      const rows = await db.query<Row>(
        `UPDATE pi_workspaces
         SET status=$4,
             provider_workspace_ref=COALESCE($5,provider_workspace_ref),
             head_commit_sha=COALESCE($6,head_commit_sha),
             workspace_digest=COALESCE($7,workspace_digest),
             failure_code=COALESCE($8,failure_code),
             updated_at=COALESCE($9,now()),
             destroyed_at=COALESCE($10,destroyed_at)
         WHERE tenant_id=$1 AND actor_id=$2 AND id=$3
         RETURNING *`,
        [context.tenantId, context.actorId, workspaceRecordId, status, patch.providerWorkspaceRef ?? null, patch.headCommitSha ?? null,
          patch.workspaceDigest ?? null, patch.failureCode ?? null, patch.updatedAt ? new Date(patch.updatedAt) : null,
          patch.destroyedAt ? new Date(patch.destroyedAt) : null],
      );
      return workspaceFromRow(rows[0]);
    });
  }

  async listWorkspaces(context: RequestContext, sessionId: string): Promise<PiWorkspaceRecord[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_workspaces WHERE tenant_id=$1 AND actor_id=$2 AND pi_session_id=$3 ORDER BY created_at DESC", [context.tenantId, context.actorId, sessionId]);
      return rows.map(workspaceFromRow);
    });
  }

  async createCredentialLease(lease: PiGitCredentialLease): Promise<void> {
    await this.scoped(this.contextForLease(lease), async (db) => {
      await db.query(
        `INSERT INTO pi_git_credential_leases
          (id,tenant_id,actor_id,pi_workspace_id,repository_id,branch,scope_digest,lease_ref,status,expires_at,created_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [lease.id, lease.tenantId, lease.actorId, lease.workspaceId, lease.repositoryId, lease.branch, lease.scopeDigest, lease.leaseRef, lease.status,
          new Date(lease.expiresAt), new Date(lease.createdAt), lease.revokedAt ? new Date(lease.revokedAt) : null],
      );
    });
  }

  async getCredentialLease(context: RequestContext, leaseId: string): Promise<PiGitCredentialLease | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_git_credential_leases WHERE tenant_id=$1 AND actor_id=$2 AND id=$3", [context.tenantId, context.actorId, leaseId]);
      return rows[0] ? leaseFromRow(rows[0]) : null;
    });
  }

  async getCredentialLeaseForWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiGitCredentialLease | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_git_credential_leases WHERE tenant_id=$1 AND actor_id=$2 AND pi_workspace_id=$3 ORDER BY created_at DESC LIMIT 1", [context.tenantId, context.actorId, workspaceRecordId]);
      return rows[0] ? leaseFromRow(rows[0]) : null;
    });
  }

  async revokeCredentialLease(context: RequestContext, leaseId: string, now = new Date()): Promise<PiGitCredentialLease> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE pi_git_credential_leases
         SET status='revoked', revoked_at=COALESCE(revoked_at,$4)
         WHERE tenant_id=$1 AND actor_id=$2 AND id=$3
         RETURNING *`,
        [context.tenantId, context.actorId, leaseId, now],
      );
      if (!rows[0]) throw new Error("PI_CREDENTIAL_LEASE_NOT_FOUND");
      return leaseFromRow(rows[0]);
    });
  }

  async createArtifact(artifact: PiWorkspaceArtifact): Promise<void> {
    await this.scoped(this.contextForArtifact(artifact), async (db) => {
      await db.query(
        `INSERT INTO workspace_artifacts
          (id,tenant_id,actor_id,pi_session_id,pi_run_id,pi_workspace_id,artifact_type,file_name,media_type,storage_ref,object_version,
           content_digest,size_bytes,classification,version,status,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [artifact.id, artifact.tenantId, artifact.actorId, artifact.sessionId, artifact.runId ?? null, artifact.workspaceId ?? null, artifact.type,
          artifact.fileName, artifact.mediaType, artifact.storageRef, artifact.objectVersion, artifact.contentDigest, artifact.sizeBytes,
          artifact.classification, artifact.version, artifact.status, artifact.expiresAt ? new Date(artifact.expiresAt) : null,
          new Date(artifact.createdAt), new Date(artifact.updatedAt)],
      );
    });
  }

  async getArtifact(context: RequestContext, artifactId: string, version?: number): Promise<PiWorkspaceArtifact | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT * FROM workspace_artifacts
         WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 AND ($4::integer IS NULL OR version=$4)
         ORDER BY version DESC LIMIT 1`,
        [context.tenantId, context.actorId, artifactId, version ?? null],
      );
      return rows[0] ? artifactFromRow(rows[0]) : null;
    });
  }

  async listArtifacts(context: RequestContext, sessionId: string): Promise<PiWorkspaceArtifact[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM workspace_artifacts WHERE tenant_id=$1 AND actor_id=$2 AND pi_session_id=$3 ORDER BY created_at DESC, version DESC", [context.tenantId, context.actorId, sessionId]);
      return rows.map(artifactFromRow);
    });
  }

  async expireArtifacts(context: RequestContext, now = new Date()): Promise<number> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE workspace_artifacts SET status='expired', updated_at=$3
         WHERE tenant_id=$1 AND actor_id=$2 AND status='active' AND expires_at IS NOT NULL AND expires_at <= $3
         RETURNING id`,
        [context.tenantId, context.actorId, now],
      );
      return rows.length;
    });
  }

  async createDownloadGrant(grant: PiDownloadGrant): Promise<void> {
    await this.scoped(this.contextForGrant(grant), async (db) => {
      await db.query(
        `INSERT INTO pi_download_grants
          (id,tenant_id,actor_id,artifact_id,artifact_version,grant_ref,url,status,expires_at,created_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [grant.id, grant.tenantId, grant.actorId, grant.artifactId, grant.artifactVersion, grant.grantRef, grant.url, grant.status,
          new Date(grant.expiresAt), new Date(grant.createdAt), grant.revokedAt ? new Date(grant.revokedAt) : null],
      );
    });
  }

  async getDownloadGrant(context: RequestContext, grantId: string): Promise<PiDownloadGrant | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_download_grants WHERE tenant_id=$1 AND actor_id=$2 AND id=$3", [context.tenantId, context.actorId, grantId]);
      return rows[0] ? grantFromRow(rows[0]) : null;
    });
  }

  async revokeDownloadGrant(context: RequestContext, grantId: string, now = new Date()): Promise<PiDownloadGrant> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE pi_download_grants SET status='revoked', revoked_at=COALESCE(revoked_at,$4)
         WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 RETURNING *`,
        [context.tenantId, context.actorId, grantId, now],
      );
      if (!rows[0]) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
      return grantFromRow(rows[0]);
    });
  }

  private contextFor(record: PiWorkspaceRecord): RequestContext {
    return { tenantId: record.tenantId, actorId: record.actorId, sessionId: record.sessionId, channel: "system", traceId: record.id, roles: ["pi-runner"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }

  private contextForLease(lease: PiGitCredentialLease): RequestContext {
    return { tenantId: lease.tenantId, actorId: lease.actorId, sessionId: "system", channel: "system", traceId: lease.id, roles: ["pi-runner"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }

  private contextForArtifact(artifact: PiWorkspaceArtifact): RequestContext {
    return { tenantId: artifact.tenantId, actorId: artifact.actorId, sessionId: artifact.sessionId, channel: "system", traceId: artifact.id, roles: ["pi-runner"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }

  private contextForGrant(grant: PiDownloadGrant): RequestContext {
    return { tenantId: grant.tenantId, actorId: grant.actorId, sessionId: "system", channel: "system", traceId: grant.id, roles: ["pi-runner"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }
}
