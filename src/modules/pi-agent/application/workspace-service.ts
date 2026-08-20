import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiGitCommit,
  PiGitCredentialLease,
  PiDownloadGrant,
  PiObjectStorageScope,
  PiRepositoryBinding,
  PiWorkspaceArtifact,
  PiWorkspaceCheckpointResult,
  PiWorkspaceContext,
  PiWorkspaceDiff,
  PiWorkspacePreparationInput,
  PiWorkspaceRecord,
  PiWorkspaceServiceDependencies,
} from "@/src/modules/pi-agent/domain/workspace-contracts";

const CREDENTIAL_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type PiCredentialLeaseView = Omit<PiGitCredentialLease, "leaseRef">;

export type PiArtifactRegistrationInput = {
  sessionId: string;
  runId?: string;
  workspaceRecordId?: string;
  type: PiWorkspaceArtifact["type"];
  fileName: string;
  mediaType: string;
  classification: PiWorkspaceArtifact["classification"];
  bytes: Uint8Array;
  retentionMs?: number;
};

export type PiCredentialIssueInput = {
  workspaceRecordId: string;
  branch?: string;
  ttlMs?: number;
};

function isProtectedBranch(branch: string): boolean {
  const normalized = branch.replace(/^refs\/heads\//, "").toLowerCase();
  return normalized === "main" || normalized === "master" || normalized === "production" || normalized === "prod" || normalized.startsWith("release/");
}

function assertFullCommitSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new Error("PI_BASE_COMMIT_INVALID");
}

function assertEphemeralBranch(branch: string): void {
  if (!/^pi\/[A-Za-z0-9._/-]+$/.test(branch) || isProtectedBranch(branch)) throw new Error("PI_EPHEMERAL_BRANCH_INVALID");
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "PI_WORKSPACE_OPERATION_FAILED";
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function workspaceContext(context: RequestContext, sessionId: string, runId: string): PiWorkspaceContext {
  return { ...context, sessionId, runId };
}

function objectStorageScope(context: RequestContext, sessionId: string, runId: string | undefined): PiObjectStorageScope {
  if (!sessionId.trim() || !runId?.trim()) throw new Error("PI_ARTIFACT_SCOPE_INVALID");
  return { tenantId: context.tenantId, actorId: context.actorId, sessionId, runId, traceId: context.traceId };
}

function safeLeaseView(lease: PiGitCredentialLease): PiCredentialLeaseView {
  const { leaseRef: _leaseRef, ...view } = lease;
  void _leaseRef;
  return view;
}

function safeFileName(fileName: string): string {
  const normalized = fileName.trim();
  if (!normalized || normalized.length > 255 || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    throw new Error("PI_ARTIFACT_FILE_NAME_INVALID");
  }
  return normalized;
}

function assertMediaType(mediaType: string): string {
  const normalized = mediaType.trim();
  if (!normalized || normalized.length > 128 || !/^[\w.+-]+\/[\w.+-]+(?:;\s*[\w.-]+=[\w.-]+)*$/.test(normalized)) throw new Error("PI_ARTIFACT_MEDIA_TYPE_INVALID");
  return normalized;
}

function assertArtifactBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("PI_ARTIFACT_TOO_LARGE");
}

export class PiWorkspaceService {
  constructor(private readonly dependencies: PiWorkspaceServiceDependencies) {}

  async getRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding> {
    assertPiPermission(context, "pi:workspace:read");
    const repository = await this.dependencies.store.getRepository(context, repositoryId);
    if (!repository) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    return repository;
  }

  async authorizeRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding> {
    assertPiPermission(context, "pi:workspace:read");
    const repository = await this.dependencies.store.getRepository(context, repositoryId);
    if (!repository) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    await this.dependencies.provider.authorizeRepository({ repository, context: workspaceContext(context, context.sessionId, context.sessionId) });
    return repository;
  }

  async issueCredential(context: RequestContext, input: PiCredentialIssueInput): Promise<PiCredentialLeaseView> {
    assertPiPermission(context, "pi:workspace:write");
    const workspace = await this.requireWorkspace(context, input.workspaceRecordId);
    const branch = input.branch ?? workspace.ephemeralBranch;
    if (branch !== workspace.ephemeralBranch) throw new Error("PI_EPHEMERAL_BRANCH_MISMATCH");
    assertEphemeralBranch(branch);
    const lease = await this.issueCredentialForWorkspace(context, workspace, branch, input.ttlMs ?? CREDENTIAL_TTL_MS);
    return safeLeaseView(lease);
  }

  async prepareWorkspace(context: RequestContext, input: PiWorkspacePreparationInput): Promise<PiWorkspaceRecord> {
    assertPiPermission(context, "pi:workspace:write");
    if (!input.sessionId || !input.runId || !input.workspaceId || !input.repositoryId || !input.baseRef.trim()) throw new Error("PI_WORKSPACE_INPUT_INVALID");
    assertFullCommitSha(input.baseCommitSha);
    const repository = await this.dependencies.store.getRepository(context, input.repositoryId);
    if (!repository) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    if (repository.workspaceId !== input.workspaceId) throw new Error("PI_WORKSPACE_REPOSITORY_MISMATCH");
    if (this.dependencies.sessionStore) {
      const session = await this.dependencies.sessionStore.getSession(context, input.sessionId);
      if (!session) throw new Error("PI_SESSION_NOT_FOUND");
      if (session.repositoryId !== input.repositoryId) throw new Error("PI_REPOSITORY_BINDING_MISMATCH");
    }

    const ephemeralBranch = this.createEphemeralBranch(input.sessionId, input.runId);
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    const initial: PiWorkspaceRecord = {
      id: workspaceId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      repositoryId: repository.id,
      provider: repository.provider,
      repositoryRef: repository.repositoryRef,
      baseRef: input.baseRef,
      baseCommitSha: input.baseCommitSha.toLowerCase(),
      ephemeralBranch,
      status: "preparing",
      createdAt: now,
      updatedAt: now,
    };
    await this.dependencies.store.createWorkspace(initial);

    let providerWorkspaceRef: string | undefined;
    let lease: PiGitCredentialLease | undefined;
    try {
      const providerContext = workspaceContext(context, input.sessionId, input.runId);
      await this.dependencies.provider.authorizeRepository({ repository, context: providerContext });
      lease = await this.issueCredentialForWorkspace(context, initial, ephemeralBranch, CREDENTIAL_TTL_MS);
      const prepared = await this.dependencies.provider.prepareWorkspace({
        repository,
        baseRef: input.baseRef,
        baseCommitSha: input.baseCommitSha,
        ephemeralBranch,
        credentialLeaseRef: lease.leaseRef,
        context: providerContext,
      });
      providerWorkspaceRef = prepared.providerWorkspaceRef;
      await this.dependencies.store.transitionWorkspace(context, workspaceId, "preparing", {
        providerWorkspaceRef,
        workspaceDigest: prepared.workspaceDigest,
      });
      await this.dependencies.provider.verifyBaseCommit({
        providerWorkspaceRef,
        baseRef: input.baseRef,
        expectedCommitSha: input.baseCommitSha,
        credentialLeaseRef: lease.leaseRef,
        context: providerContext,
      });
      const branch = await this.dependencies.provider.createEphemeralBranch({
        providerWorkspaceRef,
        branch: ephemeralBranch,
        baseCommitSha: input.baseCommitSha,
        credentialLeaseRef: lease.leaseRef,
        context: providerContext,
      });
      return this.dependencies.store.transitionWorkspace(context, workspaceId, "ready", {
        providerWorkspaceRef,
        workspaceDigest: prepared.workspaceDigest,
        headCommitSha: branch.headCommitSha,
      });
    } catch (error) {
      const cleanupErrors: string[] = [];
      const providerContext = workspaceContext(context, input.sessionId, input.runId);
      if (providerWorkspaceRef) {
        try {
          await this.dependencies.provider.cleanupWorkspace({ providerWorkspaceRef, credentialLeaseRef: lease?.leaseRef ?? "", context: providerContext });
        } catch (cleanupError) {
          cleanupErrors.push(errorCode(cleanupError));
        }
      }
      if (lease) {
        try {
          await this.dependencies.credentialBroker.revokeLease({ leaseRef: lease.leaseRef, context: providerContext });
          await this.dependencies.store.revokeCredentialLease(context, lease.id);
        } catch (cleanupError) {
          cleanupErrors.push(errorCode(cleanupError));
        }
      }
      const status = cleanupErrors.length > 0 ? "unknown" : "failed";
      try {
        await this.dependencies.store.transitionWorkspace(context, workspaceId, status, {
          providerWorkspaceRef,
          failureCode: cleanupErrors.length > 0 ? "PI_WORKSPACE_CLEANUP_UNKNOWN" : errorCode(error),
        });
      } catch {
        // The original operation error remains the user-visible result; persistence failure is recorded by the outer audit path.
      }
      if (cleanupErrors.length > 0) throw new Error("PI_WORKSPACE_CLEANUP_UNKNOWN");
      throw error;
    }
  }

  async getWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord> {
    assertPiPermission(context, "pi:workspace:read");
    return this.requireWorkspace(context, workspaceRecordId);
  }

  async listWorkspaces(context: RequestContext, sessionId: string): Promise<PiWorkspaceRecord[]> {
    assertPiPermission(context, "pi:workspace:read");
    return this.dependencies.store.listWorkspaces(context, sessionId);
  }

  async checkpoint(context: RequestContext, workspaceRecordId: string, label: string): Promise<PiWorkspaceCheckpointResult> {
    assertPiPermission(context, "pi:workspace:write");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    this.assertWorkspaceActive(workspace);
    const lease = await this.requireActiveLease(context, workspace);
    const transitioned = await this.dependencies.store.transitionWorkspace(context, workspace.id, "checkpointing");
    const providerContext = workspaceContext(context, workspace.sessionId, workspace.runId);
    try {
      const commit = await this.dependencies.provider.checkpointCommit({
        providerWorkspaceRef: this.requireProviderRef(transitioned),
        branch: workspace.ephemeralBranch,
        label: label.trim().slice(0, 200) || "checkpoint",
        credentialLeaseRef: lease.leaseRef,
        context: providerContext,
      });
      const diff = await this.computeDiffInternal(context, transitioned, lease, providerContext);
      const ready = await this.dependencies.store.transitionWorkspace(context, workspace.id, "ready", { headCommitSha: commit.commitSha });
      let checkpoint;
      if (this.dependencies.sessionStore) {
        checkpoint = {
          id: randomUUID(),
          tenantId: context.tenantId,
          sessionId: workspace.sessionId,
          label: label.trim().slice(0, 200) || "checkpoint",
          gitCommitSha: commit.commitSha,
          diffDigest: diff.diffDigest,
          snapshot: { workspaceId: workspace.id, baseCommitSha: diff.baseCommitSha, headCommitSha: diff.headCommitSha, diff: diff.diff, artifactId: diff.artifactId, truncated: diff.truncated },
          createdAt: new Date().toISOString(),
        };
        await this.dependencies.sessionStore.createCheckpoint(context, checkpoint);
      }
      return { workspace: ready, commit, diff, checkpoint };
    } catch (error) {
      try {
        await this.dependencies.store.transitionWorkspace(context, workspace.id, "unknown", { failureCode: errorCode(error) });
      } catch {
        // Preserve the operation failure; a supervisor/audit job must reconcile the unknown state.
      }
      throw error;
    }
  }

  async computeDiff(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceDiff> {
    assertPiPermission(context, "pi:workspace:read");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    this.assertWorkspaceActive(workspace);
    const lease = await this.requireActiveLease(context, workspace);
    return this.computeDiffInternal(context, workspace, lease, workspaceContext(context, workspace.sessionId, workspace.runId));
  }

  async checkpoints(context: RequestContext, sessionId: string): Promise<NonNullable<PiWorkspaceCheckpointResult["checkpoint"]>[]> {
    assertPiPermission(context, "pi:workspace:read");
    if (!this.dependencies.sessionStore) return [];
    return this.dependencies.sessionStore.listCheckpoints(context, sessionId);
  }

  async deliveryDiff(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceDiff> {
    assertPiPermission(context, "pi:workspace:read");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    if (workspace.status !== "destroyed") return this.computeDiff(context, workspaceRecordId);
    const latest = (await this.checkpoints(context, workspace.sessionId))[0];
    if (!latest || !latest.snapshot || typeof latest.snapshot !== "object") throw new Error("PI_CHANGE_DIFF_NOT_AVAILABLE");
    const snapshot = latest.snapshot as { diff?: unknown; digest?: unknown; baseCommitSha?: unknown; headCommitSha?: unknown; truncated?: unknown };
    if (typeof snapshot.diff !== "string" || typeof snapshot.baseCommitSha !== "string") throw new Error("PI_CHANGE_DIFF_NOT_AVAILABLE");
    return {
      baseCommitSha: snapshot.baseCommitSha,
      headCommitSha: typeof snapshot.headCommitSha === "string" ? snapshot.headCommitSha : workspace.headCommitSha,
      diff: snapshot.diff,
      diffDigest: typeof snapshot.digest === "string" ? snapshot.digest : latest.diffDigest,
      truncated: snapshot.truncated === true,
    };
  }

  async registerArtifact(context: RequestContext, input: PiArtifactRegistrationInput): Promise<PiWorkspaceArtifact> {
    assertPiPermission(context, "pi:workspace:write");
    assertArtifactBytes(input.bytes);
    if (!input.sessionId.trim()) throw new Error("PI_SESSION_INVALID");
    const fileName = safeFileName(input.fileName);
    const mediaType = assertMediaType(input.mediaType);
    const retentionMs = input.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!Number.isInteger(retentionMs) || retentionMs <= 0 || retentionMs > MAX_RETENTION_MS) throw new Error("PI_ARTIFACT_RETENTION_INVALID");
    let workspace: PiWorkspaceRecord | undefined;
    if (input.workspaceRecordId) {
      workspace = await this.requireWorkspace(context, input.workspaceRecordId);
      if (workspace.sessionId !== input.sessionId || (input.runId && workspace.runId !== input.runId)) throw new Error("PI_ARTIFACT_SCOPE_MISMATCH");
    }
    const artifactId = randomUUID();
    const version = 1;
    const artifactRunId = input.runId ?? workspace?.runId;
    const scope = objectStorageScope(context, input.sessionId, artifactRunId);
    const stored = await this.dependencies.objectStorage.put({
      scope,
      artifactId,
      version,
      bytes: input.bytes,
      mediaType,
      classification: input.classification,
    });
    if (stored.sizeBytes !== input.bytes.byteLength || stored.contentDigest !== bytesDigest(input.bytes)) {
      await this.dependencies.objectStorage.deleteObject({ scope, artifactId, version, storageRef: stored.storageRef }).catch(() => undefined);
      throw new Error("PI_ARTIFACT_DIGEST_MISMATCH");
    }
    const now = new Date();
    const artifact: PiWorkspaceArtifact = {
      id: artifactId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      sessionId: input.sessionId,
      runId: artifactRunId,
      workspaceId: workspace?.id,
      type: input.type,
      fileName,
      mediaType,
      storageRef: stored.storageRef,
      objectVersion: stored.objectVersion,
      contentDigest: stored.contentDigest,
      sizeBytes: stored.sizeBytes,
      classification: input.classification,
      version,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + retentionMs).toISOString(),
    };
    try {
      await this.dependencies.store.createArtifact(artifact);
    } catch (error) {
      await this.dependencies.objectStorage.deleteObject({ scope, artifactId, version, storageRef: stored.storageRef }).catch(() => undefined);
      throw error;
    }
    return artifact;
  }

  async listArtifacts(context: RequestContext, sessionId: string): Promise<PiWorkspaceArtifact[]> {
    assertPiPermission(context, "pi:workspace:read");
    await this.dependencies.store.expireArtifacts(context);
    return this.dependencies.store.listArtifacts(context, sessionId);
  }

  async issueDownloadGrant(context: RequestContext, artifactId: string, version?: number, ttlMs = DOWNLOAD_GRANT_TTL_MS): Promise<PiDownloadGrant> {
    assertPiPermission(context, "pi:workspace:read");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_DOWNLOAD_GRANT_TTL_MS) throw new Error("PI_DOWNLOAD_GRANT_TTL_INVALID");
    await this.dependencies.store.expireArtifacts(context);
    const artifact = await this.dependencies.store.getArtifact(context, artifactId, version);
    if (!artifact) throw new Error("PI_ARTIFACT_NOT_FOUND");
    if (artifact.status !== "active" || (artifact.expiresAt && new Date(artifact.expiresAt) <= new Date())) throw new Error("PI_ARTIFACT_NOT_ACTIVE");
    const issued = await this.dependencies.objectStorage.issueDownloadGrant({ scope: objectStorageScope(context, artifact.sessionId, artifact.runId), artifactId: artifact.id, version: artifact.version, storageRef: artifact.storageRef, ttlMs });
    const now = new Date().toISOString();
    const grant: PiDownloadGrant = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      grantRef: issued.grantRef,
      url: issued.url,
      status: "active",
      expiresAt: issued.expiresAt,
      createdAt: now,
    };
    try {
      await this.dependencies.store.createDownloadGrant(grant);
    } catch (error) {
      await this.dependencies.objectStorage.revokeDownloadGrant({ scope: objectStorageScope(context, artifact.sessionId, artifact.runId), grantRef: issued.grantRef }).catch(() => undefined);
      throw error;
    }
    return grant;
  }

  async revokeDownloadGrant(context: RequestContext, grantId: string): Promise<PiDownloadGrant> {
    assertPiPermission(context, "pi:workspace:write");
    const grant = await this.dependencies.store.getDownloadGrant(context, grantId);
    if (!grant) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
    const artifact = await this.dependencies.store.getArtifact(context, grant.artifactId, grant.artifactVersion);
    if (!artifact) throw new Error("PI_ARTIFACT_NOT_FOUND");
    await this.dependencies.objectStorage.revokeDownloadGrant({ scope: objectStorageScope(context, artifact.sessionId, artifact.runId), grantRef: grant.grantRef });
    return this.dependencies.store.revokeDownloadGrant(context, grantId);
  }

  async cleanupCredential(context: RequestContext, workspaceRecordId: string): Promise<PiCredentialLeaseView> {
    assertPiPermission(context, "pi:workspace:write");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    const lease = await this.dependencies.store.getCredentialLeaseForWorkspace(context, workspace.id);
    if (!lease) throw new Error("PI_CREDENTIAL_LEASE_NOT_FOUND");
    await this.dependencies.credentialBroker.revokeLease({ leaseRef: lease.leaseRef, context: workspaceContext(context, workspace.sessionId, workspace.runId) });
    return safeLeaseView(await this.dependencies.store.revokeCredentialLease(context, lease.id));
  }

  async cleanupWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord> {
    assertPiPermission(context, "pi:workspace:write");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    if (workspace.status === "destroyed") return workspace;
    if (!["ready", "failed", "unknown"].includes(workspace.status)) throw new Error("PI_WORKSPACE_STATE_CONFLICT");
    const lease = await this.dependencies.store.getCredentialLeaseForWorkspace(context, workspace.id);
    const destroying = await this.dependencies.store.transitionWorkspace(context, workspace.id, "destroying");
    const providerContext = workspaceContext(context, workspace.sessionId, workspace.runId);
    const errors: string[] = [];
    if (destroying.providerWorkspaceRef) {
      try {
        await this.dependencies.provider.cleanupWorkspace({ providerWorkspaceRef: destroying.providerWorkspaceRef, credentialLeaseRef: lease?.leaseRef ?? "", context: providerContext });
      } catch (error) {
        errors.push(errorCode(error));
      }
    }
    if (lease) {
      try {
        await this.dependencies.credentialBroker.revokeLease({ leaseRef: lease.leaseRef, context: providerContext });
        await this.dependencies.store.revokeCredentialLease(context, lease.id);
      } catch (error) {
        errors.push(errorCode(error));
      }
    }
    if (errors.length > 0) {
      await this.dependencies.store.transitionWorkspace(context, workspace.id, "unknown", { failureCode: "PI_WORKSPACE_CLEANUP_UNKNOWN" }).catch(() => undefined);
      throw new Error("PI_WORKSPACE_CLEANUP_UNKNOWN");
    }
    return this.dependencies.store.transitionWorkspace(context, workspace.id, "destroyed", { destroyedAt: new Date().toISOString() });
  }

  async pushBranch(context: RequestContext, workspaceRecordId: string): Promise<{ branch: string; headCommitSha: string }> {
    assertPiPermission(context, "pi:change:submit");
    const workspace = await this.requireWorkspace(context, workspaceRecordId);
    this.assertWorkspaceActive(workspace);
    if (isProtectedBranch(workspace.ephemeralBranch)) throw new Error("PI_PROTECTED_BRANCH");
    const lease = await this.requireActiveLease(context, workspace);
    try {
      return await this.dependencies.provider.pushBranch({ providerWorkspaceRef: this.requireProviderRef(workspace), branch: workspace.ephemeralBranch, credentialLeaseRef: lease.leaseRef, context: workspaceContext(context, workspace.sessionId, workspace.runId) });
    } catch (error) {
      await this.dependencies.store.transitionWorkspace(context, workspace.id, "unknown", { failureCode: errorCode(error) }).catch(() => undefined);
      throw error;
    }
  }

  async applyRetention(context: RequestContext, now = new Date()): Promise<number> {
    assertPiPermission(context, "pi:workspace:write");
    return this.dependencies.store.expireArtifacts(context, now);
  }

  private async requireWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord> {
    const workspace = await this.dependencies.store.getWorkspace(context, workspaceRecordId);
    if (!workspace) throw new Error("PI_WORKSPACE_NOT_FOUND");
    return workspace;
  }

  private async issueCredentialForWorkspace(context: RequestContext, workspace: PiWorkspaceRecord, branch: string, ttlMs: number): Promise<PiGitCredentialLease> {
    if (isProtectedBranch(branch) || branch !== workspace.ephemeralBranch) throw new Error("PI_PROTECTED_BRANCH");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) throw new Error("PI_CREDENTIAL_TTL_INVALID");
    const repository = await this.dependencies.store.getRepository(context, workspace.repositoryId);
    if (!repository || repository.status !== "active") throw new Error("PI_REPOSITORY_NOT_FOUND");
    const credentialContext = workspaceContext(context, workspace.sessionId, workspace.runId);
    const issued = await this.dependencies.credentialBroker.issueLease({ repository, workspaceId: workspace.id, branch, ttlMs, context: credentialContext });
    const lease: PiGitCredentialLease = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      workspaceId: workspace.id,
      repositoryId: repository.id,
      branch,
      scopeDigest: issued.scopeDigest,
      leaseRef: issued.leaseRef,
      status: "active",
      expiresAt: issued.expiresAt,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.dependencies.store.createCredentialLease(lease);
    } catch (error) {
      await this.dependencies.credentialBroker.revokeLease({ leaseRef: issued.leaseRef, context: credentialContext }).catch(() => undefined);
      throw error;
    }
    return lease;
  }

  private async requireActiveLease(context: RequestContext, workspace: PiWorkspaceRecord): Promise<PiGitCredentialLease> {
    const lease = await this.dependencies.store.getCredentialLeaseForWorkspace(context, workspace.id);
    if (!lease) throw new Error("PI_CREDENTIAL_LEASE_NOT_FOUND");
    if (lease.status !== "active" || new Date(lease.expiresAt) <= new Date()) throw new Error("PI_CREDENTIAL_LEASE_EXPIRED");
    return lease;
  }

  private async computeDiffInternal(context: RequestContext, workspace: PiWorkspaceRecord, lease: PiGitCredentialLease, providerContext: PiWorkspaceContext): Promise<PiWorkspaceDiff> {
    const result = await this.dependencies.provider.computeDiff({
      providerWorkspaceRef: this.requireProviderRef(workspace),
      baseCommitSha: workspace.baseCommitSha,
      branch: workspace.ephemeralBranch,
      credentialLeaseRef: lease.leaseRef,
      context: providerContext,
    });
    const serverDigest = sha256(result.diff);
    if (result.diffDigest !== serverDigest) throw new Error("PI_DIFF_DIGEST_MISMATCH");
    if (result.baseCommitSha.toLowerCase() !== workspace.baseCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
    if (Buffer.byteLength(result.diff) <= MAX_INLINE_DIFF_BYTES) {
      return { baseCommitSha: result.baseCommitSha, headCommitSha: result.headCommitSha, diffDigest: serverDigest, diff: result.diff, truncated: false };
    }
    const artifact = await this.registerArtifact(context, {
      sessionId: workspace.sessionId,
      runId: workspace.runId,
      workspaceRecordId: workspace.id,
      type: "diff",
      fileName: `diff-${workspace.id}.patch`,
      mediaType: "text/x-diff",
      classification: "internal",
      bytes: Buffer.from(result.diff),
    });
    return { baseCommitSha: result.baseCommitSha, headCommitSha: result.headCommitSha, diffDigest: serverDigest, diff: "", truncated: true, artifactId: artifact.id };
  }

  private assertWorkspaceActive(workspace: PiWorkspaceRecord): void {
    if (!["ready", "checkpointing"].includes(workspace.status)) throw new Error("PI_WORKSPACE_NOT_ACTIVE");
  }

  private requireProviderRef(workspace: PiWorkspaceRecord): string {
    if (!workspace.providerWorkspaceRef) throw new Error("PI_WORKSPACE_PROVIDER_REF_MISSING");
    return workspace.providerWorkspaceRef;
  }

  private createEphemeralBranch(sessionId: string, runId: string): string {
    const branch = `pi/${sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24)}/${runId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24)}`;
    assertEphemeralBranch(branch);
    return branch;
  }
}

export type { PiGitCommit };
