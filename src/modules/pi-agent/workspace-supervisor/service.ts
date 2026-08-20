import { createHash, randomUUID } from "node:crypto";
import type { PiArtifactClassification, PiRepositoryBinding, PiWorkspaceProviderBranch, PiWorkspaceProviderCheckpoint, PiWorkspaceProviderDiff } from "@/src/modules/pi-agent/domain/workspace-contracts";
import type { PiSupervisorWorkspace, PiWorkspaceLease, PiWorkspaceSupervisorConfig, PiWorkspaceSupervisorContext, PiWorkspaceSupervisorPersistedLease, PiWorkspaceSupervisorState } from "@/src/modules/pi-agent/workspace-supervisor/contracts";
import { ForgejoGitWorkspaceAdapter } from "@/src/modules/pi-agent/workspace-supervisor/git-adapter";
import { S3WorkspaceObjectStore } from "@/src/modules/pi-agent/workspace-supervisor/s3-object-store";
import { InMemoryPiWorkspaceSupervisorStateStore, JsonFilePiWorkspaceSupervisorStateStore, type PiWorkspaceSupervisorStateStore } from "@/src/modules/pi-agent/workspace-supervisor/state-store";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertScope(context: PiWorkspaceSupervisorContext): void {
  if (![context.tenantId, context.actorId, context.sessionId, context.runId, context.traceId].every((value) => validText(value))) throw new Error("PI_WORKSPACE_SCOPE_INVALID");
}

function assertRepositoryInput(input: { repositoryId: string; repositoryRef: string; workspaceId?: string }, context: PiWorkspaceSupervisorContext): void {
  assertScope(context);
  if (!validText(input.repositoryId, 128) || !validText(input.repositoryRef, 512) || (input.workspaceId !== undefined && !validText(input.workspaceId, 256))) throw new Error("PI_REPOSITORY_INPUT_INVALID");
}

function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new Error("PI_BASE_COMMIT_INVALID");
}

function assertBranch(value: string): void {
  if (!/^pi\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.includes("\\")) throw new Error("PI_EPHEMERAL_BRANCH_INVALID");
  const normalized = value.toLowerCase();
  if (["pi/main", "pi/master", "pi/production", "pi/prod"].includes(normalized) || normalized.includes("/release/")) throw new Error("PI_PROTECTED_BRANCH");
}

function assertLeaseRef(value: string): void {
  if (!validText(value, 2_000)) throw new Error("PI_CREDENTIAL_LEASE_INVALID");
}

function repository(input: { repositoryId: string; repositoryRef: string; workspaceId: string }, context: PiWorkspaceSupervisorContext): PiRepositoryBinding {
  assertRepositoryInput(input, context);
  return {
    id: input.repositoryId,
    tenantId: context.tenantId,
    workspaceId: input.workspaceId,
    provider: "forgejo",
    repositoryRef: input.repositoryRef,
    defaultBranch: "main",
    credentialRef: "opaque://server-managed",
    status: "active",
    createdAt: new Date(0).toISOString(),
  };
}

function sameScope(left: PiWorkspaceSupervisorContext, right: PiWorkspaceSupervisorContext): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionId === right.sessionId && left.runId === right.runId;
}

export class PiWorkspaceSupervisorService {
  readonly git: ForgejoGitWorkspaceAdapter;
  readonly objects: S3WorkspaceObjectStore;
  private readonly leases = new Map<string, PiWorkspaceLease>();
  private readonly stateStore: PiWorkspaceSupervisorStateStore;
  private readonly readyPromise: Promise<void>;
  private persistQueue: Promise<void> = Promise.resolve();
  private stateFailure?: Error;

  constructor(private readonly config: PiWorkspaceSupervisorConfig, stateStore?: PiWorkspaceSupervisorStateStore) {
    const publicUrl = new URL(config.publicBaseUrl);
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new Error("PI_WORKSPACE_PUBLIC_URL_MUST_USE_HTTPS");
    this.stateStore = stateStore ?? (config.stateFile ? new JsonFilePiWorkspaceSupervisorStateStore(config.stateFile) : new InMemoryPiWorkspaceSupervisorStateStore());
    this.git = new ForgejoGitWorkspaceAdapter(config);
    this.objects = new S3WorkspaceObjectStore(config);
    this.readyPromise = this.restoreState();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
    if (this.stateFailure) throw this.stateFailure;
    if (this.stateStore.renew) {
      try {
        await this.stateStore.renew();
      } catch (error) {
        this.stateFailure = error instanceof Error ? error : new Error("PI_WORKSPACE_STATE_RENEW_FAILED");
        throw this.stateFailure;
      }
    }
  }

  async close(): Promise<void> {
    await this.readyPromise.catch(() => undefined);
    await this.stateStore.release?.();
  }

  async readiness(): Promise<{ ready: boolean; code?: string }> {
    try {
      await this.ready();
      return this.objects.readiness();
    } catch (error) {
      return { ready: false, code: error instanceof Error ? error.message : "PI_WORKSPACE_STATE_INVALID" };
    }
  }

  async authorizeRepository(input: { repositoryId: string; repositoryRef: string }, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    const binding = repository({ ...input, workspaceId: "unresolved" }, context);
    await this.git.authorizeRepository(binding, context);
  }

  async issueCredential(input: { repositoryId: string; repositoryRef: string; workspaceId: string; branch: string; ttlMs: number }, context: PiWorkspaceSupervisorContext): Promise<{ leaseRef: string; scopeDigest: string; expiresAt: string }> {
    await this.ready();
    const binding = repository(input, context);
    assertBranch(input.branch);
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 15 * 60 * 1000) throw new Error("PI_CREDENTIAL_TTL_INVALID");
    const leaseRef = `openbao://lease/${randomUUID()}`;
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    const lease: PiWorkspaceLease = {
      leaseRef,
      scope: context,
      repositoryId: binding.id,
      repositoryRef: binding.repositoryRef,
      workspaceId: input.workspaceId,
      branch: input.branch,
      expiresAt,
      username: this.config.forgejoUsername,
      token: this.config.forgejoToken,
    };
    this.leases.set(leaseRef, lease);
    try {
      await this.persistState(context);
    } catch (error) {
      this.leases.delete(leaseRef);
      throw error;
    }
    return { leaseRef, scopeDigest: digest(JSON.stringify({ tenantId: context.tenantId, actorId: context.actorId, sessionId: context.sessionId, runId: context.runId, repositoryId: binding.id, workspaceId: input.workspaceId, branch: input.branch })), expiresAt };
  }

  async revokeCredential(leaseRef: string, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    assertLeaseRef(leaseRef);
    const lease = this.leases.get(leaseRef);
    if (!lease) return;
    if (!sameScope(lease.scope, context)) throw new Error("PI_CREDENTIAL_SCOPE_MISMATCH");
    this.leases.delete(leaseRef);
    try {
      await this.persistState(context);
    } catch (error) {
      this.leases.set(leaseRef, lease);
      throw error;
    }
  }

  async prepare(input: { repositoryId: string; repositoryRef: string; baseRef: string; baseCommitSha: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<{ providerWorkspaceRef: string; workspaceDigest: string }> {
    await this.ready();
    assertCommitSha(input.baseCommitSha);
    assertLeaseRef(input.credentialLeaseRef);
    assertRepositoryInput(input, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, input.repositoryId, undefined, undefined);
    const binding = repository({ ...input, workspaceId: lease.workspaceId }, context);
    const result = await this.git.prepare({ repository: binding, baseRef: input.baseRef, baseCommitSha: input.baseCommitSha, context, lease });
    try {
      await this.persistState(context);
    } catch (error) {
      await this.git.cleanup(result.workspace, lease, context).catch(() => undefined);
      throw error;
    }
    return { providerWorkspaceRef: result.workspace.providerWorkspaceRef, workspaceDigest: result.workspaceDigest };
  }

  async verifyBase(input: { providerWorkspaceRef: string; baseRef: string; expectedCommitSha: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, workspace.repository.id, workspace.workspaceId, workspace.branch);
    await this.git.verifyBaseCommit(workspace, input.baseRef, input.expectedCommitSha, lease);
  }

  async createBranch(input: { providerWorkspaceRef: string; branch: string; baseCommitSha: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<PiWorkspaceProviderBranch> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, workspace.repository.id, workspace.workspaceId, input.branch);
    const result = await this.git.createBranch(workspace, input.branch, input.baseCommitSha, lease);
    await this.persistState(context);
    return result;
  }

  async checkpoint(input: { providerWorkspaceRef: string; branch: string; label: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<PiWorkspaceProviderCheckpoint> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, workspace.repository.id, workspace.workspaceId, input.branch);
    const result = await this.git.checkpoint(workspace, input.branch, input.label, lease);
    await this.persistState(context);
    return result;
  }

  async diff(input: { providerWorkspaceRef: string; baseCommitSha: string; branch: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<PiWorkspaceProviderDiff> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, workspace.repository.id, workspace.workspaceId, input.branch);
    const result = await this.git.diff(workspace, input.baseCommitSha, input.branch, lease);
    await this.persistState(context);
    return result;
  }

  async push(input: { providerWorkspaceRef: string; branch: string; credentialLeaseRef: string }, context: PiWorkspaceSupervisorContext): Promise<{ branch: string; headCommitSha: string }> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.requireLease(input.credentialLeaseRef, context, workspace.repository.id, workspace.workspaceId, input.branch);
    const result = await this.git.push(workspace, input.branch, lease);
    await this.persistState(context);
    return result;
  }

  async cleanup(input: { providerWorkspaceRef: string; credentialLeaseRef?: string }, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    const workspace = this.requireWorkspace(input.providerWorkspaceRef, context);
    const lease = this.resolveCleanupLease(input.credentialLeaseRef, context, workspace);
    await this.git.cleanup(workspace, lease, context);
    for (const [leaseRef, item] of this.leases.entries()) if (item.workspaceId === workspace.workspaceId && sameScope(item.scope, context)) this.leases.delete(leaseRef);
    await this.persistState(context);
  }

  async putObject(input: { artifactId: string; version: number; bytes: Uint8Array; mediaType: string; classification: PiArtifactClassification }, context: PiWorkspaceSupervisorContext): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }> {
    await this.ready();
    const result = await this.objects.put({ ...input, scope: context });
    await this.persistState(context);
    return result;
  }

  async issueDownloadGrant(input: { artifactId: string; version: number; storageRef: string; ttlMs: number }, context: PiWorkspaceSupervisorContext): Promise<{ grantRef: string; url: string; expiresAt: string }> {
    await this.ready();
    const result = await this.objects.issueGrant({ ...input, scope: context });
    await this.persistState(context);
    return result;
  }

  async revokeDownloadGrant(grantRef: string, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    await this.objects.revokeGrant(context, grantRef);
    await this.persistState(context);
  }

  async deleteObject(input: { artifactId: string; version: number; storageRef: string }, context: PiWorkspaceSupervisorContext): Promise<void> {
    await this.ready();
    await this.objects.delete({ ...input, scope: context });
    await this.persistState(context);
  }

  async download(grantRef: string): Promise<{ bytes: Uint8Array; mediaType: string; contentDigest: string }> {
    await this.ready();
    const result = await this.objects.download(grantRef);
    await this.persistState();
    return { bytes: result.bytes, mediaType: result.mediaType, contentDigest: result.object.contentDigest };
  }

  private requireWorkspace(providerWorkspaceRef: string, context: PiWorkspaceSupervisorContext): PiSupervisorWorkspace {
    if (!validText(providerWorkspaceRef, 2_000)) throw new Error("PI_WORKSPACE_REF_INVALID");
    return this.git.get(providerWorkspaceRef, context);
  }

  private resolveCleanupLease(leaseRef: string | undefined, context: PiWorkspaceSupervisorContext, workspace: PiSupervisorWorkspace): PiWorkspaceLease | undefined {
    if (!leaseRef?.trim()) return undefined;
    assertLeaseRef(leaseRef);
    const lease = this.leases.get(leaseRef);
    // Cleanup is a destructive operation on an already scope-bound workspace and does not need Git credentials.
    // An expired or lost opaque lease must not strand the workspace; a known lease still gets full scope checks.
    if (!lease) return undefined;
    if (!sameScope(lease.scope, context) || lease.repositoryId !== workspace.repository.id || lease.workspaceId !== workspace.workspaceId || (workspace.branch !== undefined && lease.branch !== workspace.branch)) throw new Error("PI_CREDENTIAL_SCOPE_MISMATCH");
    if (new Date(lease.expiresAt).getTime() <= Date.now()) return undefined;
    return lease;
  }

  private requireLease(leaseRef: string, context: PiWorkspaceSupervisorContext, repositoryId: string, workspaceId: string | undefined, branch: string | undefined): PiWorkspaceLease {
    assertLeaseRef(leaseRef);
    const lease = this.leases.get(leaseRef);
    if (!lease) throw new Error("PI_CREDENTIAL_LEASE_NOT_FOUND");
    if (new Date(lease.expiresAt).getTime() <= Date.now()) throw new Error("PI_CREDENTIAL_LEASE_EXPIRED");
    if (!sameScope(lease.scope, context) || lease.repositoryId !== repositoryId || (workspaceId !== undefined && lease.workspaceId !== workspaceId) || (branch !== undefined && lease.branch !== branch)) throw new Error("PI_CREDENTIAL_SCOPE_MISMATCH");
    return lease;
  }

  private async restoreState(): Promise<void> {
    const state = await this.stateStore.load();
    this.leases.clear();
    for (const persisted of state.leases) {
      if (new Date(persisted.expiresAt).getTime() <= Date.now()) continue;
      this.leases.set(persisted.leaseRef, { ...persisted, username: this.config.forgejoUsername, token: this.config.forgejoToken });
    }
    for (const workspace of state.workspaces) await this.git.restore(workspace);
    this.objects.restore({ objects: state.objects, grants: state.grants });
    await this.stateStore.save(this.snapshot());
  }

  private snapshot(): PiWorkspaceSupervisorState {
    const leases: PiWorkspaceSupervisorPersistedLease[] = [...this.leases.values()].map((lease) => ({
      leaseRef: lease.leaseRef,
      scope: { ...lease.scope },
      repositoryId: lease.repositoryId,
      repositoryRef: lease.repositoryRef,
      workspaceId: lease.workspaceId,
      branch: lease.branch,
      expiresAt: lease.expiresAt,
    }));
    const objectState = this.objects.snapshot();
    return {
      schemaVersion: 1,
      leases,
      workspaces: this.git.snapshot(),
      objects: objectState.objects,
      grants: objectState.grants,
    };
  }

  private async persistState(context?: PiWorkspaceSupervisorContext): Promise<void> {
    const options = context ? { tenantIds: [context.tenantId] } : undefined;
    const operation = this.persistQueue.then(() => this.stateStore.save(this.snapshot(), options));
    this.persistQueue = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      this.stateFailure = error instanceof Error ? error : new Error("PI_WORKSPACE_STATE_PERSIST_FAILED");
      throw this.stateFailure;
    }
  }
}
