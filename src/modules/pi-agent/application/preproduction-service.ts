import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiPreproductionEvent,
  PiPreproductionEventKind,
  PiPreproductionSnapshot,
  PiPreproductionStore,
  PiReadinessCheck,
  PiReadinessSnapshot,
  PiReleaseCandidate,
  PiSecretLease,
} from "@/src/modules/pi-agent/domain/preproduction-contracts";
import type { McpAuditScopeReadinessPort } from "@/src/modules/pi-agent/domain/mcp-contracts";

export type PiReleaseDraft = {
  version: string;
  imageDigest: string;
  manifestDigest: string;
  signatureDigest: string;
  sbomDigest?: string;
};

export type PiSecretLeaseDraft = {
  reference: string;
  purpose: string;
  audience: string;
  ttlSeconds: number;
};

export interface PiPreproductionProbe {
  probe(context: RequestContext, release: PiReleaseCandidate): Promise<PiReadinessCheck[]>;
}

export class CompositePiPreproductionProbe implements PiPreproductionProbe {
  constructor(private readonly probes: PiPreproductionProbe[]) {}

  async probe(context: RequestContext, release: PiReleaseCandidate): Promise<PiReadinessCheck[]> {
    return (await Promise.all(this.probes.map((probe) => probe.probe(context, release)))).flat();
  }
}

export class McpAuditScopePreproductionProbe implements PiPreproductionProbe {
  constructor(private readonly readiness: McpAuditScopeReadinessPort) {}

  async probe(_context: RequestContext, _release: PiReleaseCandidate): Promise<PiReadinessCheck[]> {
    void _context;
    void _release;
    try {
      const result = await this.readiness.check();
      return [{
        id: "mcp.audit.execution_scope",
        category: "security",
        status: result.ready ? "pass" : "fail",
        message: result.ready ? "MCP 审计 Session/Run scope 约束已验证。" : `MCP 审计 scope 约束未就绪：${result.code}。`,
      }];
    } catch {
      return [{ id: "mcp.audit.execution_scope", category: "security", status: "fail", message: "MCP 审计 scope readiness 检查失败，Gate 保持关闭。" }];
    }
  }
}

export class FailClosedPiPreproductionProbe implements PiPreproductionProbe {
  async probe(): Promise<PiReadinessCheck[]> {
    return [
      { id: "preproduction.probe", category: "operations", status: "fail", message: "真实预生产探针未接通，发布门禁保持关闭。" },
      { id: "preproduction.recovery", category: "recovery", status: "fail", message: "灾备恢复演练证据未接通，发布门禁保持关闭。" },
    ];
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertText(value: string, code: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

function assertDigest(value: string | undefined, code: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function assertVersion(value: string): string {
  const version = assertText(value, "PI_RELEASE_VERSION_INVALID", 64);
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/.test(version)) throw new Error("PI_RELEASE_VERSION_INVALID");
  return version;
}

function assertId(value: string, code: string): string {
  const id = assertText(value, code, 128);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(code);
  return id;
}

function assertProbeChecks(checks: PiReadinessCheck[]): PiReadinessCheck[] {
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 64) throw new Error("PI_READINESS_PROBE_EMPTY");
  return checks.map((check) => ({
    id: assertText(check.id, "PI_READINESS_CHECK_INVALID", 128),
    category: check.category,
    status: check.status,
    message: assertText(check.message, "PI_READINESS_CHECK_INVALID", 512),
    ...(check.evidenceDigest ? { evidenceDigest: assertDigest(check.evidenceDigest, "PI_READINESS_EVIDENCE_INVALID") } : {}),
  }));
}

function readinessFailureDigest(checks: PiReadinessCheck[]): string | undefined {
  const failures = checks.filter((check) => check.status !== "pass");
  return failures.length > 0 ? digest(failures) : undefined;
}

function event(
  context: RequestContext,
  kind: PiPreproductionEventKind,
  subject: string,
  createdAt: string,
): PiPreproductionEvent {
  return { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, kind, subjectDigest: assertDigest(subject, "PI_PREPRODUCTION_SUBJECT_INVALID")!, traceId: context.traceId, createdAt };
}

export class PiPreproductionService {
  private readonly policyVersion: number;

  constructor(
    private readonly store: PiPreproductionStore,
    private readonly probe: PiPreproductionProbe = new FailClosedPiPreproductionProbe(),
    options: { policyVersion?: number } = {},
  ) {
    this.policyVersion = options.policyVersion ?? 1;
  }

  async registerRelease(context: RequestContext, draft: PiReleaseDraft, idempotencyKey?: string): Promise<PiReleaseCandidate> {
    assertPiPermission(context, "pi:release:propose");
    const normalized = {
      version: assertVersion(draft.version),
      imageDigest: assertDigest(draft.imageDigest, "PI_RELEASE_IMAGE_DIGEST_INVALID")!,
      manifestDigest: assertDigest(draft.manifestDigest, "PI_RELEASE_MANIFEST_DIGEST_INVALID")!,
      signatureDigest: assertDigest(draft.signatureDigest, "PI_RELEASE_SIGNATURE_DIGEST_INVALID")!,
      ...(draft.sbomDigest ? { sbomDigest: assertDigest(draft.sbomDigest, "PI_RELEASE_SBOM_DIGEST_INVALID") } : {}),
    };
    const actionDigest = digest({ tenantId: context.tenantId, idempotencyKey: idempotencyKey?.trim() || undefined, ...normalized });
    const existing = await this.store.findReleaseByActionDigest(context, actionDigest);
    if (existing) return existing;
    const release: PiReleaseCandidate = {
      id: randomUUID(), tenantId: context.tenantId, createdBy: context.actorId, ...normalized, actionDigest, status: "candidate", createdAt: new Date().toISOString(),
    };
    return (await this.store.putRelease(release)).release;
  }

  async listReleases(context: RequestContext): Promise<PiReleaseCandidate[]> {
    assertPiPermission(context, "pi:preproduction:read");
    return this.store.listReleases(context);
  }

  async evaluateReadiness(context: RequestContext, releaseId: string): Promise<PiReadinessSnapshot> {
    assertPiPermission(context, "pi:preproduction:read");
    const release = await this.store.findRelease(context, assertId(releaseId, "PI_RELEASE_ID_INVALID"));
    if (!release) throw new Error("PI_RELEASE_NOT_FOUND");
    let checks: PiReadinessCheck[];
    try {
      checks = assertProbeChecks([
        { id: "artifact.integrity", category: "artifact", status: "pass", message: "发布制品摘要格式和签名摘要格式已通过服务端校验。", evidenceDigest: release.manifestDigest },
        ...(await this.probe.probe(context, release)),
      ]);
    } catch {
      checks = [
        { id: "preproduction.probe.failed", category: "operations", status: "fail", message: "预生产探针执行失败，发布门禁保持关闭。", evidenceDigest: digest({ releaseId: release.id, policyVersion: this.policyVersion }) },
      ];
    }
    const generatedAt = new Date().toISOString();
    const snapshot: PiReadinessSnapshot = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, releaseId: release.id,
      ready: checks.length > 0 && checks.every((check) => check.status === "pass"), checks, policyVersion: this.policyVersion,
      generatedAt, ...(readinessFailureDigest(checks) ? { failureDigest: readinessFailureDigest(checks) } : {}),
    };
    await this.store.putReadiness(snapshot);
    await this.store.appendEvent(event(context, "pi.preproduction.readiness_evaluated", digest({ releaseId: release.id, readinessId: snapshot.id, ready: snapshot.ready }), generatedAt));
    return snapshot;
  }

  async latestReadiness(context: RequestContext, releaseId: string): Promise<PiReadinessSnapshot | null> {
    assertPiPermission(context, "pi:preproduction:read");
    return this.store.latestReadiness(context, assertId(releaseId, "PI_RELEASE_ID_INVALID"));
  }

  async listReadiness(context: RequestContext, limit = 100): Promise<PiReadinessSnapshot[]> {
    assertPiPermission(context, "pi:preproduction:read");
    return this.store.listReadiness(context, Math.min(Math.max(limit, 1), 1000));
  }

  async promoteRelease(context: RequestContext, releaseId: string): Promise<PiReleaseCandidate> {
    assertPiPermission(context, "pi:release:propose");
    const id = assertId(releaseId, "PI_RELEASE_ID_INVALID");
    const release = await this.store.findRelease(context, id);
    if (!release) throw new Error("PI_RELEASE_NOT_FOUND");
    if (release.status === "active") return release;
    if (release.status === "rolled_back") throw new Error("PI_RELEASE_STATE_CONFLICT");
    const readiness = await this.store.latestReadiness(context, id);
    if (!readiness || !readiness.ready) throw new Error("PI_PREPROD_NOT_READY");
    const promoted = await this.store.promoteRelease(context, id, new Date().toISOString());
    await this.store.appendEvent(event(context, "pi.release.promoted", promoted.manifestDigest, new Date().toISOString()));
    return promoted;
  }

  async rollbackRelease(context: RequestContext, releaseId: string): Promise<PiReleaseCandidate> {
    assertPiPermission(context, "pi:release:propose");
    const id = assertId(releaseId, "PI_RELEASE_ID_INVALID");
    const release = await this.store.findRelease(context, id);
    if (!release) throw new Error("PI_RELEASE_NOT_FOUND");
    if (release.status === "rolled_back") return release;
    if (release.status !== "active") throw new Error("PI_RELEASE_STATE_CONFLICT");
    const rolledBack = await this.store.rollbackRelease(context, id, new Date().toISOString());
    await this.store.appendEvent(event(context, "pi.release.rolled_back", rolledBack.manifestDigest, new Date().toISOString()));
    return rolledBack;
  }

  async issueSecretLease(context: RequestContext, draft: PiSecretLeaseDraft): Promise<PiSecretLease> {
    assertPiPermission(context, "pi:secret:lease");
    const purpose = assertText(draft.purpose, "PI_SECRET_LEASE_PURPOSE_INVALID", 128);
    const audience = assertText(draft.audience, "PI_SECRET_LEASE_AUDIENCE_INVALID", 128);
    if (!Number.isInteger(draft.ttlSeconds) || draft.ttlSeconds < 1 || draft.ttlSeconds > 3600) throw new Error("PI_SECRET_LEASE_TTL_INVALID");
    const reference = assertText(draft.reference, "PI_SECRET_REFERENCE_SCOPE_INVALID", 512);
    const prefix = `secret://tenants/${context.tenantId}/`;
    if (!reference.startsWith(prefix) || !/^[A-Za-z0-9/_-]+$/.test(reference.slice(prefix.length)) || reference.includes("..")) throw new Error("PI_SECRET_REFERENCE_SCOPE_INVALID");
    const issuedAt = new Date();
    const lease: PiSecretLease = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, purpose, audience,
      referenceDigest: digest(reference), status: "active", issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + draft.ttlSeconds * 1000).toISOString(),
    };
    await this.store.putSecretLease(lease);
    await this.store.appendEvent(event(context, "pi.secret.lease_issued", lease.referenceDigest, lease.issuedAt));
    return lease;
  }

  async listSecretLeases(context: RequestContext): Promise<PiSecretLease[]> {
    assertPiPermission(context, "pi:preproduction:read");
    return this.store.listSecretLeases(context);
  }

  async revokeSecretLease(context: RequestContext, leaseId: string): Promise<PiSecretLease> {
    assertPiPermission(context, "pi:secret:revoke");
    const id = assertId(leaseId, "PI_SECRET_LEASE_ID_INVALID");
    const lease = await this.store.findSecretLease(context, id);
    if (!lease) throw new Error("PI_SECRET_LEASE_NOT_FOUND");
    if (lease.status === "revoked") throw new Error("PI_SECRET_LEASE_STATE_CONFLICT");
    const revoked = await this.store.revokeSecretLease(context, id, new Date().toISOString(), context.actorId);
    await this.store.appendEvent(event(context, "pi.secret.lease_revoked", revoked.referenceDigest, revoked.revokedAt ?? new Date().toISOString()));
    return revoked;
  }

  async assertLeaseActive(context: RequestContext, leaseId: string): Promise<PiSecretLease> {
    const lease = await this.store.findSecretLease(context, assertId(leaseId, "PI_SECRET_LEASE_ID_INVALID"));
    if (!lease) throw new Error("PI_SECRET_LEASE_NOT_FOUND");
    if (lease.status !== "active") throw new Error("PI_SECRET_LEASE_STATE_CONFLICT");
    if (new Date(lease.expiresAt).getTime() <= Date.now()) throw new Error("PI_SECRET_LEASE_EXPIRED");
    return lease;
  }

  async listEvents(context: RequestContext, limit = 100): Promise<PiPreproductionEvent[]> {
    assertPiPermission(context, "pi:preproduction:read");
    return this.store.listEvents(context, Math.min(Math.max(limit, 1), 1000));
  }

  async snapshot(context: RequestContext): Promise<PiPreproductionSnapshot> {
    assertPiPermission(context, "pi:preproduction:read");
    const [releases, readiness, secretLeases, events] = await Promise.all([
      this.store.listReleases(context), this.store.listReadiness(context, 100), this.store.listSecretLeases(context), this.store.listEvents(context, 100),
    ]);
    return { releases, readiness, secretLeases, events, generatedAt: new Date().toISOString() };
  }
}
