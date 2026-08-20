import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiArtifactResourceRelease,
  PiResourceRegistryStore,
  PiResourceScope,
  PiResourceRiskLevel,
  PiResourceClassification,
  PiResourceApprovalStatus,
  PiResourceScanStatus,
  PiSkillRelease,
} from "@/src/modules/pi-agent/domain/resource-contracts";
import type { PiProfileId } from "@/src/modules/pi-agent/domain/contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function optionalIso(value: unknown): string | undefined { return value === null || value === undefined ? undefined : iso(value); }
function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return [];
}

function skillFromRow(row: Row): PiSkillRelease {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), skillId: String(row.skill_id), version: String(row.version), scope: row.scope as PiResourceScope,
    digest: String(row.digest), signature: String(row.signature), contentRef: row.content_ref ? String(row.content_ref) : undefined, content: row.content ? String(row.content) : undefined,
    requiredTools: jsonArray<string>(row.required_tools), dataClassification: row.data_classification as PiResourceClassification, riskLevel: row.risk_level as PiResourceRiskLevel,
    allowedProfiles: jsonArray<PiProfileId>(row.allowed_profiles), approvalStatus: row.approval_status as PiResourceApprovalStatus, rolloutPercent: Number(row.rollout_percent ?? 0),
    createdAt: iso(row.created_at), approvedAt: optionalIso(row.approved_at), revokedAt: optionalIso(row.revoked_at),
  };
}

function artifactFromRow(row: Row): PiArtifactResourceRelease {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), resourceId: String(row.resource_id), kind: row.resource_kind as PiArtifactResourceRelease["kind"], version: String(row.version),
    digest: String(row.digest), signature: String(row.signature), artifactRef: String(row.artifact_ref), sbomDigest: String(row.sbom_digest), scanStatus: row.scan_status as PiResourceScanStatus,
    approvalStatus: row.approval_status as PiResourceApprovalStatus, rolloutPercent: Number(row.rollout_percent ?? 0), allowedProfiles: jsonArray<PiProfileId>(row.allowed_profiles),
    dataClassification: row.data_classification as PiResourceClassification, riskLevel: row.risk_level as PiResourceRiskLevel, createdAt: iso(row.created_at),
    approvedAt: optionalIso(row.approved_at), revokedAt: optionalIso(row.revoked_at),
  };
}

export class InMemoryPiResourceRegistryStore implements PiResourceRegistryStore {
  private readonly skills = new Map<string, PiSkillRelease>();
  private readonly artifacts = new Map<string, PiArtifactResourceRelease>();

  async putSkillRelease(release: PiSkillRelease): Promise<void> {
    const key = `${release.tenantId}:${release.skillId}:${release.version}`;
    if (this.skills.has(key)) throw new Error("PI_RESOURCE_RELEASE_DUPLICATE");
    this.skills.set(key, clone(release));
  }

  async getSkillRelease(context: RequestContext, skillId: string, version?: string): Promise<PiSkillRelease | null> {
    const values = [...this.skills.values()].filter((release) => release.tenantId === context.tenantId && release.skillId === skillId && (!version || release.version === version)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return values[0] ? clone(values[0]) : null;
  }

  async listSkillReleases(context: RequestContext): Promise<PiSkillRelease[]> {
    return [...this.skills.values()].filter((release) => release.tenantId === context.tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async updateSkillRelease(context: RequestContext, skillId: string, version: string, patch: Partial<Pick<PiSkillRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt">>): Promise<PiSkillRelease> {
    const key = `${context.tenantId}:${skillId}:${version}`;
    const current = this.skills.get(key);
    if (!current) throw new Error("PI_SKILL_RELEASE_NOT_FOUND");
    const updated = clone({ ...current, ...patch });
    this.skills.set(key, updated);
    return updated;
  }

  async putArtifactResourceRelease(release: PiArtifactResourceRelease): Promise<void> {
    const key = `${release.tenantId}:${release.kind}:${release.resourceId}:${release.version}`;
    if (this.artifacts.has(key)) throw new Error("PI_RESOURCE_RELEASE_DUPLICATE");
    this.artifacts.set(key, clone(release));
  }

  async getArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version?: string): Promise<PiArtifactResourceRelease | null> {
    const values = [...this.artifacts.values()].filter((release) => release.tenantId === context.tenantId && release.kind === kind && release.resourceId === resourceId && (!version || release.version === version)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return values[0] ? clone(values[0]) : null;
  }

  async listArtifactResourceReleases(context: RequestContext, kind?: "package" | "extension"): Promise<PiArtifactResourceRelease[]> {
    return [...this.artifacts.values()].filter((release) => release.tenantId === context.tenantId && (!kind || release.kind === kind)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async updateArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version: string, patch: Partial<Pick<PiArtifactResourceRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt" | "scanStatus">>): Promise<PiArtifactResourceRelease> {
    const key = `${context.tenantId}:${kind}:${resourceId}:${version}`;
    const current = this.artifacts.get(key);
    if (!current) throw new Error("PI_RESOURCE_RELEASE_NOT_FOUND");
    const updated = clone({ ...current, ...patch });
    this.artifacts.set(key, updated);
    return updated;
  }
}

export class PostgresPiResourceRegistryStore implements PiResourceRegistryStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }
  private systemContext(tenantId: string, traceId: string): RequestContext {
    return { tenantId, actorId: "00000000-0000-4000-8000-000000000000", sessionId: "system", channel: "system", traceId, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }

  async putSkillRelease(release: PiSkillRelease): Promise<void> {
    await this.scoped(this.systemContext(release.tenantId, release.id), async (db) => {
      await db.query(
        `INSERT INTO skill_releases
          (id,tenant_id,skill_id,version,scope,digest,signature,content_ref,content,required_tools,data_classification,risk_level,allowed_profiles,approval_status,rollout_percent,approved_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [release.id, release.tenantId, release.skillId, release.version, release.scope, release.digest, release.signature, release.contentRef ?? null, release.content ?? null,
          release.requiredTools, release.dataClassification, release.riskLevel, release.allowedProfiles, release.approvalStatus, release.rolloutPercent,
          release.approvedAt ? new Date(release.approvedAt) : null, release.revokedAt ? new Date(release.revokedAt) : null],
      );
    });
  }

  async getSkillRelease(context: RequestContext, skillId: string, version?: string): Promise<PiSkillRelease | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM skill_releases WHERE tenant_id=$1 AND skill_id=$2 AND ($3::text IS NULL OR version=$3) ORDER BY created_at DESC LIMIT 1", [context.tenantId, skillId, version ?? null]);
      return rows[0] ? skillFromRow(rows[0]) : null;
    });
  }

  async listSkillReleases(context: RequestContext): Promise<PiSkillRelease[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM skill_releases WHERE tenant_id=$1 ORDER BY created_at DESC", [context.tenantId])).map(skillFromRow));
  }

  async updateSkillRelease(context: RequestContext, skillId: string, version: string, patch: Partial<Pick<PiSkillRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt">>): Promise<PiSkillRelease> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE skill_releases SET approval_status=COALESCE($4,approval_status), rollout_percent=COALESCE($5,rollout_percent), approved_at=COALESCE($6,approved_at), revoked_at=CASE WHEN $7::boolean THEN $8::timestamptz ELSE revoked_at END
         WHERE tenant_id=$1 AND skill_id=$2 AND version=$3 RETURNING *`,
        [context.tenantId, skillId, version, patch.approvalStatus ?? null, patch.rolloutPercent ?? null, patch.approvedAt ? new Date(patch.approvedAt) : null,
          Object.prototype.hasOwnProperty.call(patch, "revokedAt"), patch.revokedAt ? new Date(patch.revokedAt) : null],
      );
      if (!rows[0]) throw new Error("PI_SKILL_RELEASE_NOT_FOUND");
      return skillFromRow(rows[0]);
    });
  }

  async putArtifactResourceRelease(release: PiArtifactResourceRelease): Promise<void> {
    await this.scoped(this.systemContext(release.tenantId, release.id), async (db) => {
      await db.query(
        `INSERT INTO pi_resource_releases
          (id,tenant_id,resource_id,resource_kind,version,digest,signature,artifact_ref,sbom_digest,scan_status,approval_status,rollout_percent,allowed_profiles,data_classification,risk_level,approved_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [release.id, release.tenantId, release.resourceId, release.kind, release.version, release.digest, release.signature, release.artifactRef, release.sbomDigest, release.scanStatus,
          release.approvalStatus, release.rolloutPercent, release.allowedProfiles, release.dataClassification, release.riskLevel, release.approvedAt ? new Date(release.approvedAt) : null,
          release.revokedAt ? new Date(release.revokedAt) : null],
      );
    });
  }

  async getArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version?: string): Promise<PiArtifactResourceRelease | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_resource_releases WHERE tenant_id=$1 AND resource_kind=$2 AND resource_id=$3 AND ($4::text IS NULL OR version=$4) ORDER BY created_at DESC LIMIT 1", [context.tenantId, kind, resourceId, version ?? null]);
      return rows[0] ? artifactFromRow(rows[0]) : null;
    });
  }

  async listArtifactResourceReleases(context: RequestContext, kind?: "package" | "extension"): Promise<PiArtifactResourceRelease[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_resource_releases WHERE tenant_id=$1 AND ($2::text IS NULL OR resource_kind=$2) ORDER BY created_at DESC", [context.tenantId, kind ?? null])).map(artifactFromRow));
  }

  async updateArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version: string, patch: Partial<Pick<PiArtifactResourceRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt" | "scanStatus">>): Promise<PiArtifactResourceRelease> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE pi_resource_releases SET scan_status=COALESCE($5,scan_status), approval_status=COALESCE($6,approval_status), rollout_percent=COALESCE($7,rollout_percent), approved_at=COALESCE($8,approved_at), revoked_at=CASE WHEN $9::boolean THEN $10::timestamptz ELSE revoked_at END
         WHERE tenant_id=$1 AND resource_kind=$2 AND resource_id=$3 AND version=$4 RETURNING *`,
        [context.tenantId, kind, resourceId, version, patch.scanStatus ?? null, patch.approvalStatus ?? null, patch.rolloutPercent ?? null, patch.approvedAt ? new Date(patch.approvedAt) : null,
          Object.prototype.hasOwnProperty.call(patch, "revokedAt"), patch.revokedAt ? new Date(patch.revokedAt) : null],
      );
      if (!rows[0]) throw new Error("PI_RESOURCE_RELEASE_NOT_FOUND");
      return artifactFromRow(rows[0]);
    });
  }
}
