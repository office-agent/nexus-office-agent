import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiPreproductionEvent,
  PiPreproductionStore,
  PiReadinessCheck,
  PiReadinessSnapshot,
  PiReleaseCandidate,
  PiSecretLease,
} from "@/src/modules/pi-agent/domain/preproduction-contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }
function text(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : text(value); }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function releaseFromRow(row: Row): PiReleaseCandidate {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), createdBy: text(row.created_by), version: text(row.version),
    imageDigest: text(row.image_digest), manifestDigest: text(row.manifest_digest), signatureDigest: text(row.signature_digest),
    ...(optionalText(row.sbom_digest) ? { sbomDigest: text(row.sbom_digest) } : {}), actionDigest: text(row.action_digest),
    status: row.status as PiReleaseCandidate["status"], createdAt: iso(row.created_at),
    ...(row.activated_at ? { activatedAt: iso(row.activated_at) } : {}), ...(row.rolled_back_at ? { rolledBackAt: iso(row.rolled_back_at) } : {}),
  };
}

function readinessFromRow(row: Row): PiReadinessSnapshot {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), actorId: text(row.actor_id), releaseId: text(row.release_id), ready: Boolean(row.ready),
    checks: jsonValue<PiReadinessCheck[]>(row.checks), policyVersion: Number(row.policy_version), generatedAt: iso(row.generated_at),
    ...(optionalText(row.failure_digest) ? { failureDigest: text(row.failure_digest) } : {}),
  };
}

function leaseFromRow(row: Row): PiSecretLease {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), actorId: text(row.actor_id), purpose: text(row.purpose), audience: text(row.audience),
    referenceDigest: text(row.reference_digest), status: row.status as PiSecretLease["status"], issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}), ...(row.revoke_actor_id ? { revokeActorId: text(row.revoke_actor_id) } : {}),
  };
}

function eventFromRow(row: Row): PiPreproductionEvent {
  return { id: text(row.id), tenantId: text(row.tenant_id), actorId: text(row.actor_id), kind: row.kind as PiPreproductionEvent["kind"], subjectDigest: text(row.subject_digest), traceId: text(row.trace_id), createdAt: iso(row.created_at) };
}

export class InMemoryPiPreproductionStore implements PiPreproductionStore {
  private readonly releases = new Map<string, PiReleaseCandidate>();
  private readonly readiness = new Map<string, PiReadinessSnapshot>();
  private readonly leases = new Map<string, PiSecretLease>();
  private readonly events = new Map<string, PiPreproductionEvent>();

  async putRelease(release: PiReleaseCandidate): Promise<{ release: PiReleaseCandidate; created: boolean }> {
    const existing = [...this.releases.values()].find((item) => item.tenantId === release.tenantId && item.actionDigest === release.actionDigest);
    if (existing) return { release: clone(existing), created: false };
    this.releases.set(`${release.tenantId}:${release.id}`, clone(release));
    return { release: clone(release), created: true };
  }

  async findRelease(context: RequestContext, id: string): Promise<PiReleaseCandidate | null> {
    const item = this.releases.get(`${context.tenantId}:${id}`);
    return item ? clone(item) : null;
  }

  async findReleaseByActionDigest(context: RequestContext, actionDigest: string): Promise<PiReleaseCandidate | null> {
    const item = [...this.releases.values()].find((candidate) => candidate.tenantId === context.tenantId && candidate.actionDigest === actionDigest);
    return item ? clone(item) : null;
  }

  async listReleases(context: RequestContext): Promise<PiReleaseCandidate[]> {
    return [...this.releases.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async promoteRelease(context: RequestContext, id: string, activatedAt: string): Promise<PiReleaseCandidate> {
    const target = this.releases.get(`${context.tenantId}:${id}`);
    if (!target) throw new Error("PI_RELEASE_NOT_FOUND");
    if (target.status === "active") return clone(target);
    if (target.status === "rolled_back") throw new Error("PI_RELEASE_STATE_CONFLICT");
    for (const [key, item] of this.releases.entries()) {
      if (item.tenantId === context.tenantId && item.status === "active" && item.id !== id) this.releases.set(key, { ...item, status: "rolled_back", rolledBackAt: activatedAt });
    }
    const updated = { ...target, status: "active" as const, activatedAt };
    this.releases.set(`${context.tenantId}:${id}`, updated);
    return clone(updated);
  }

  async rollbackRelease(context: RequestContext, id: string, rolledBackAt: string): Promise<PiReleaseCandidate> {
    const target = this.releases.get(`${context.tenantId}:${id}`);
    if (!target) throw new Error("PI_RELEASE_NOT_FOUND");
    if (target.status === "rolled_back") return clone(target);
    if (target.status !== "active") throw new Error("PI_RELEASE_STATE_CONFLICT");
    const updated = { ...target, status: "rolled_back" as const, rolledBackAt };
    this.releases.set(`${context.tenantId}:${id}`, updated);
    return clone(updated);
  }

  async putReadiness(snapshot: PiReadinessSnapshot): Promise<void> { this.readiness.set(`${snapshot.tenantId}:${snapshot.id}`, clone(snapshot)); }

  async latestReadiness(context: RequestContext, releaseId: string): Promise<PiReadinessSnapshot | null> {
    const item = [...this.readiness.values()].filter((candidate) => candidate.tenantId === context.tenantId && candidate.releaseId === releaseId).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
    return item ? clone(item) : null;
  }

  async listReadiness(context: RequestContext, limit = 100): Promise<PiReadinessSnapshot[]> {
    return [...this.readiness.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).slice(0, limit).map(clone);
  }

  async putSecretLease(lease: PiSecretLease): Promise<void> { this.leases.set(`${lease.tenantId}:${lease.id}`, clone(lease)); }

  async findSecretLease(context: RequestContext, id: string): Promise<PiSecretLease | null> {
    const item = this.leases.get(`${context.tenantId}:${id}`);
    return item ? clone(item) : null;
  }

  async listSecretLeases(context: RequestContext): Promise<PiSecretLease[]> {
    return [...this.leases.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).map(clone);
  }

  async revokeSecretLease(context: RequestContext, id: string, revokedAt: string, actorId: string): Promise<PiSecretLease> {
    const item = this.leases.get(`${context.tenantId}:${id}`);
    if (!item) throw new Error("PI_SECRET_LEASE_NOT_FOUND");
    if (item.status !== "active") throw new Error("PI_SECRET_LEASE_STATE_CONFLICT");
    const updated = { ...item, status: "revoked" as const, revokedAt, revokeActorId: actorId };
    this.leases.set(`${context.tenantId}:${id}`, updated);
    return clone(updated);
  }

  async appendEvent(item: PiPreproductionEvent): Promise<void> { this.events.set(`${item.tenantId}:${item.id}`, clone(item)); }

  async listEvents(context: RequestContext, limit = 100): Promise<PiPreproductionEvent[]> {
    return [...this.events.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone);
  }
}

export class PostgresPiPreproductionStore implements PiPreproductionStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }

  async putRelease(release: PiReleaseCandidate): Promise<{ release: PiReleaseCandidate; created: boolean }> {
    return this.scoped({ tenantId: release.tenantId, actorId: release.createdBy, sessionId: "system", channel: "system", traceId: release.actionDigest, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }, async (db) => {
      const rows = await db.query<Row>("INSERT INTO pi_release_candidates(id,tenant_id,created_by,version,image_digest,manifest_digest,signature_digest,sbom_digest,action_digest,status,created_at,activated_at,rolled_back_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,action_digest) DO NOTHING RETURNING *", [release.id, release.tenantId, release.createdBy, release.version, release.imageDigest, release.manifestDigest, release.signatureDigest, release.sbomDigest ?? null, release.actionDigest, release.status, new Date(release.createdAt), release.activatedAt ? new Date(release.activatedAt) : null, release.rolledBackAt ? new Date(release.rolledBackAt) : null]);
      if (rows[0]) return { release: releaseFromRow(rows[0]), created: true };
      const existing = await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 AND action_digest=$2", [release.tenantId, release.actionDigest]);
      if (!existing[0]) throw new Error("PI_RELEASE_WRITE_CONFLICT");
      return { release: releaseFromRow(existing[0]), created: false };
    });
  }

  async findRelease(context: RequestContext, id: string): Promise<PiReleaseCandidate | null> {
    return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 AND id=$2", [context.tenantId, id]); return rows[0] ? releaseFromRow(rows[0]) : null; });
  }

  async findReleaseByActionDigest(context: RequestContext, actionDigest: string): Promise<PiReleaseCandidate | null> {
    return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 AND action_digest=$2", [context.tenantId, actionDigest]); return rows[0] ? releaseFromRow(rows[0]) : null; });
  }

  async listReleases(context: RequestContext): Promise<PiReleaseCandidate[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 ORDER BY created_at DESC", [context.tenantId])).map(releaseFromRow));
  }

  async promoteRelease(context: RequestContext, id: string, activatedAt: string): Promise<PiReleaseCandidate> {
    return this.scoped(context, async (db) => {
      await db.query("UPDATE pi_release_candidates SET status='rolled_back',rolled_back_at=$2 WHERE tenant_id=$1 AND status='active' AND id<>$3", [context.tenantId, new Date(activatedAt), id]);
      const rows = await db.query<Row>("UPDATE pi_release_candidates SET status='active',activated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('candidate','staged') RETURNING *", [context.tenantId, id, new Date(activatedAt)]);
      if (rows[0]) return releaseFromRow(rows[0]);
      const current = await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 AND id=$2", [context.tenantId, id]);
      if (!current[0]) throw new Error("PI_RELEASE_NOT_FOUND");
      if (current[0].status === "active") return releaseFromRow(current[0]);
      throw new Error("PI_RELEASE_STATE_CONFLICT");
    });
  }

  async rollbackRelease(context: RequestContext, id: string, rolledBackAt: string): Promise<PiReleaseCandidate> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("UPDATE pi_release_candidates SET status='rolled_back',rolled_back_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING *", [context.tenantId, id, new Date(rolledBackAt)]);
      if (rows[0]) return releaseFromRow(rows[0]);
      const current = await db.query<Row>("SELECT * FROM pi_release_candidates WHERE tenant_id=$1 AND id=$2", [context.tenantId, id]);
      if (!current[0]) throw new Error("PI_RELEASE_NOT_FOUND");
      if (current[0].status === "rolled_back") return releaseFromRow(current[0]);
      throw new Error("PI_RELEASE_STATE_CONFLICT");
    });
  }

  async putReadiness(snapshot: PiReadinessSnapshot): Promise<void> {
    await this.scoped({ tenantId: snapshot.tenantId, actorId: snapshot.actorId, sessionId: "system", channel: "system", traceId: snapshot.id, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }, async (db) => {
      await db.query("INSERT INTO pi_readiness_snapshots(id,tenant_id,actor_id,release_id,ready,checks,policy_version,generated_at,failure_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)", [snapshot.id, snapshot.tenantId, snapshot.actorId, snapshot.releaseId, snapshot.ready, JSON.stringify(snapshot.checks), snapshot.policyVersion, new Date(snapshot.generatedAt), snapshot.failureDigest ?? null]);
    });
  }

  async latestReadiness(context: RequestContext, releaseId: string): Promise<PiReadinessSnapshot | null> {
    return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_readiness_snapshots WHERE tenant_id=$1 AND release_id=$2 ORDER BY generated_at DESC LIMIT 1", [context.tenantId, releaseId]); return rows[0] ? readinessFromRow(rows[0]) : null; });
  }

  async listReadiness(context: RequestContext, limit = 100): Promise<PiReadinessSnapshot[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_readiness_snapshots WHERE tenant_id=$1 ORDER BY generated_at DESC LIMIT $2", [context.tenantId, limit])).map(readinessFromRow));
  }

  async putSecretLease(lease: PiSecretLease): Promise<void> {
    await this.scoped({ tenantId: lease.tenantId, actorId: lease.actorId, sessionId: "system", channel: "system", traceId: lease.id, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }, async (db) => {
      await db.query("INSERT INTO pi_secret_leases(id,tenant_id,actor_id,purpose,audience,reference_digest,status,issued_at,expires_at,revoked_at,revoke_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [lease.id, lease.tenantId, lease.actorId, lease.purpose, lease.audience, lease.referenceDigest, lease.status, new Date(lease.issuedAt), new Date(lease.expiresAt), lease.revokedAt ? new Date(lease.revokedAt) : null, lease.revokeActorId ?? null]);
    });
  }

  async findSecretLease(context: RequestContext, id: string): Promise<PiSecretLease | null> {
    return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_secret_leases WHERE tenant_id=$1 AND id=$2", [context.tenantId, id]); return rows[0] ? leaseFromRow(rows[0]) : null; });
  }

  async listSecretLeases(context: RequestContext): Promise<PiSecretLease[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_secret_leases WHERE tenant_id=$1 ORDER BY issued_at DESC", [context.tenantId])).map(leaseFromRow));
  }

  async revokeSecretLease(context: RequestContext, id: string, revokedAt: string, actorId: string): Promise<PiSecretLease> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("UPDATE pi_secret_leases SET status='revoked',revoked_at=$3,revoke_actor_id=$4 WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING *", [context.tenantId, id, new Date(revokedAt), actorId]);
      if (rows[0]) return leaseFromRow(rows[0]);
      const current = await db.query<Row>("SELECT * FROM pi_secret_leases WHERE tenant_id=$1 AND id=$2", [context.tenantId, id]);
      if (!current[0]) throw new Error("PI_SECRET_LEASE_NOT_FOUND");
      throw new Error("PI_SECRET_LEASE_STATE_CONFLICT");
    });
  }

  async appendEvent(item: PiPreproductionEvent): Promise<void> {
    await this.scoped({ tenantId: item.tenantId, actorId: item.actorId, sessionId: "system", channel: "system", traceId: item.traceId, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }, async (db) => {
      await db.query("INSERT INTO pi_preproduction_events(id,tenant_id,actor_id,kind,subject_digest,trace_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [item.id, item.tenantId, item.actorId, item.kind, item.subjectDigest, item.traceId, new Date(item.createdAt)]);
    });
  }

  async listEvents(context: RequestContext, limit = 100): Promise<PiPreproductionEvent[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_preproduction_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2", [context.tenantId, limit])).map(eventFromRow));
  }
}
