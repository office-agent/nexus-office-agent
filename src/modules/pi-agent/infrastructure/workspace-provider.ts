import { createHash, randomUUID } from "node:crypto";
import type {
  PiGitCredentialBroker,
  PiRepositoryBinding,
  PiWorkspaceProvider,
  PiWorkspaceProviderBranch,
  PiWorkspaceProviderCheckpoint,
  PiWorkspaceProviderDiff,
  PiWorkspaceProviderPreparation,
  PiWorkspaceContext,
} from "@/src/modules/pi-agent/domain/workspace-contracts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type PiCredentialScope = Pick<PiWorkspaceContext, "tenantId" | "actorId" | "sessionId" | "runId">;

function assertCredentialContext(context: PiWorkspaceContext): void {
  if (![context.tenantId, context.actorId, context.sessionId, context.runId, context.traceId].every((value) => typeof value === "string" && value.trim().length > 0)) {
    throw new Error("PI_CREDENTIAL_SCOPE_INVALID");
  }
}

function credentialScope(context: PiWorkspaceContext): PiCredentialScope {
  assertCredentialContext(context);
  return { tenantId: context.tenantId, actorId: context.actorId, sessionId: context.sessionId, runId: context.runId };
}

function sameCredentialScope(left: PiCredentialScope, right: PiWorkspaceContext): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionId === right.sessionId && left.runId === right.runId;
}

function assertLeaseRef(value: string): void {
  if (!value.trim() || value.length > 2_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("PI_CREDENTIAL_LEASE_INVALID");
}

function assertSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new Error("PI_BASE_COMMIT_INVALID");
}

function assertEphemeralBranch(branch: string): void {
  if (!/^pi\/[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("PI_EPHEMERAL_BRANCH_INVALID");
}

function isProtectedBranch(branch: string): boolean {
  const normalized = branch.replace(/^refs\/heads\//, "").toLowerCase();
  return normalized === "main" || normalized === "master" || normalized === "production" || normalized === "prod" || normalized.startsWith("release/");
}

type VirtualWorkspaceState = {
  repository: PiRepositoryBinding;
  context: PiWorkspaceContext;
  baseRef: string;
  baseCommitSha: string;
  branch?: string;
  headCommitSha?: string;
  diff: string;
  commitSequence: number;
};

export class VirtualPiWorkspaceProvider implements PiWorkspaceProvider {
  readonly kind = "virtual" as const;
  private readonly states = new Map<string, VirtualWorkspaceState>();

  async authorizeRepository(input: { repository: PiRepositoryBinding; context: PiWorkspaceContext }): Promise<void> {
    if (input.repository.tenantId !== input.context.tenantId) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (input.repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    if (!input.repository.repositoryRef.trim()) throw new Error("PI_REPOSITORY_INVALID");
  }

  async prepareWorkspace(input: {
    repository: PiRepositoryBinding;
    baseRef: string;
    baseCommitSha: string;
    ephemeralBranch: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<PiWorkspaceProviderPreparation> {
    await this.authorizeRepository({ repository: input.repository, context: input.context });
    assertSha(input.baseCommitSha);
    assertEphemeralBranch(input.ephemeralBranch);
    if (!input.credentialLeaseRef.trim()) throw new Error("PI_CREDENTIAL_LEASE_INVALID");
    const providerWorkspaceRef = `virtual://pi-workspace/${randomUUID()}`;
    this.states.set(providerWorkspaceRef, {
      repository: input.repository,
      context: input.context,
      baseRef: input.baseRef,
      baseCommitSha: input.baseCommitSha.toLowerCase(),
      diff: "",
      commitSequence: 0,
    });
    return {
      providerWorkspaceRef,
      workspaceDigest: digest(JSON.stringify({ repository: input.repository.repositoryRef, baseRef: input.baseRef, baseCommitSha: input.baseCommitSha })),
    };
  }

  async verifyBaseCommit(input: { providerWorkspaceRef: string; baseRef: string; expectedCommitSha: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    const state = this.state(input.providerWorkspaceRef, input.context);
    assertSha(input.expectedCommitSha);
    if (state.baseRef !== input.baseRef || state.baseCommitSha !== input.expectedCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
  }

  async createEphemeralBranch(input: { providerWorkspaceRef: string; branch: string; baseCommitSha: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderBranch> {
    const state = this.state(input.providerWorkspaceRef, input.context);
    if (isProtectedBranch(input.branch)) throw new Error("PI_PROTECTED_BRANCH");
    assertEphemeralBranch(input.branch);
    if (state.repository.defaultBranch === input.branch || input.branch === "main" || input.branch === "master") throw new Error("PI_PROTECTED_BRANCH");
    if (state.baseCommitSha !== input.baseCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
    state.branch = input.branch;
    state.headCommitSha = state.baseCommitSha;
    return { branch: input.branch, headCommitSha: state.headCommitSha };
  }

  async checkpointCommit(input: { providerWorkspaceRef: string; branch: string; label: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderCheckpoint> {
    const state = this.state(input.providerWorkspaceRef, input.context);
    this.assertBranch(state, input.branch);
    state.commitSequence += 1;
    const commitSha = digest(`${state.headCommitSha}:${input.label}:${state.commitSequence}`);
    state.headCommitSha = commitSha;
    return { commitSha, branch: input.branch, messageDigest: digest(input.label), createdAt: new Date().toISOString() };
  }

  async computeDiff(input: { providerWorkspaceRef: string; baseCommitSha: string; branch: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderDiff> {
    const state = this.state(input.providerWorkspaceRef, input.context);
    this.assertBranch(state, input.branch);
    if (state.baseCommitSha !== input.baseCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
    return {
      baseCommitSha: state.baseCommitSha,
      headCommitSha: state.headCommitSha,
      diff: state.diff,
      diffDigest: digest(state.diff),
    };
  }

  async pushBranch(input: { providerWorkspaceRef: string; branch: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<{ branch: string; headCommitSha: string }> {
    const state = this.state(input.providerWorkspaceRef, input.context);
    this.assertBranch(state, input.branch);
    if (!state.headCommitSha) throw new Error("PI_WORKSPACE_HEAD_MISSING");
    return { branch: input.branch, headCommitSha: state.headCommitSha };
  }

  async cleanupWorkspace(input: { providerWorkspaceRef: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    const state = this.states.get(input.providerWorkspaceRef);
    if (!state) return;
    if (state.context.tenantId !== input.context.tenantId || state.context.actorId !== input.context.actorId) throw new Error("PI_WORKSPACE_NOT_FOUND");
    this.states.delete(input.providerWorkspaceRef);
  }

  /** Test-only change simulation; it never reads or writes the host filesystem. */
  seedDiff(providerWorkspaceRef: string, diff: string): void {
    const state = this.states.get(providerWorkspaceRef);
    if (!state) throw new Error("PI_WORKSPACE_NOT_FOUND");
    state.diff = diff;
  }

  private state(providerWorkspaceRef: string, context: PiWorkspaceContext): VirtualWorkspaceState {
    const state = this.states.get(providerWorkspaceRef);
    if (!state || state.context.tenantId !== context.tenantId || state.context.actorId !== context.actorId) throw new Error("PI_WORKSPACE_NOT_FOUND");
    return state;
  }

  private assertBranch(state: VirtualWorkspaceState, branch: string): asserts state is VirtualWorkspaceState & { branch: string; headCommitSha: string } {
    if (!state.branch || state.branch !== branch) throw new Error("PI_EPHEMERAL_BRANCH_NOT_FOUND");
    if (!state.headCommitSha) throw new Error("PI_WORKSPACE_HEAD_MISSING");
  }
}

export interface WorkspaceSupervisorClient {
  request<T>(path: string, payload: Record<string, unknown>, context: PiWorkspaceContext): Promise<T>;
}

function requireHttpsEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("PI_WORKSPACE_ENDPOINT_MUST_USE_HTTPS");
  return url;
}

function assertRequestPath(value: string): void {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("..") || value.includes("?") || value.includes("#") || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("PI_WORKSPACE_REQUEST_PATH_INVALID");
}

function assertProviderWorkspaceRef(value: string): void {
  try {
    const url = new URL(value);
    if (!["workspace:", "virtual:", "forgejo:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.port || url.search || url.hash || value.length > 1_000) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
  } catch {
    throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
  }
}

export class HttpWorkspaceSupervisorClient implements WorkspaceSupervisorClient {
  private readonly endpoint: URL;

  constructor(endpoint: string) {
    this.endpoint = requireHttpsEndpoint(endpoint);
  }

  async request<T>(path: string, payload: Record<string, unknown>, context: PiWorkspaceContext): Promise<T> {
    assertRequestPath(path);
    const target = new URL(path.replace(/^\//, ""), this.endpoint);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": context.tenantId,
        "x-actor-id": context.actorId,
        "x-session-id": context.sessionId,
        "x-run-id": context.runId,
        "x-trace-id": context.traceId,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`PI_WORKSPACE_SUPERVISOR_HTTP_${response.status}`);
    if (response.status === 204) return undefined as T;
    const data = await response.json() as T;
    return data;
  }
}

export class RemotePiWorkspaceProvider implements PiWorkspaceProvider {
  readonly kind = "remote" as const;

  constructor(private readonly client: WorkspaceSupervisorClient) {}

  async authorizeRepository(input: { repository: PiRepositoryBinding; context: PiWorkspaceContext }): Promise<void> {
    await this.client.request("/v1/repositories/authorize", { repositoryId: input.repository.id, repositoryRef: input.repository.repositoryRef }, input.context);
  }

  async prepareWorkspace(input: { repository: PiRepositoryBinding; baseRef: string; baseCommitSha: string; ephemeralBranch: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderPreparation> {
    const result = await this.client.request<PiWorkspaceProviderPreparation>("/v1/workspaces/prepare", {
      repositoryId: input.repository.id,
      repositoryRef: input.repository.repositoryRef,
      baseRef: input.baseRef,
      baseCommitSha: input.baseCommitSha,
      ephemeralBranch: input.ephemeralBranch,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
    if (!result.providerWorkspaceRef || !result.workspaceDigest) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
    assertProviderWorkspaceRef(result.providerWorkspaceRef);
    return result;
  }

  async verifyBaseCommit(input: { providerWorkspaceRef: string; baseRef: string; expectedCommitSha: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    await this.client.request("/v1/workspaces/verify-base", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      baseRef: input.baseRef,
      expectedCommitSha: input.expectedCommitSha,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
  }

  async createEphemeralBranch(input: { providerWorkspaceRef: string; branch: string; baseCommitSha: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderBranch> {
    const result = await this.client.request<PiWorkspaceProviderBranch>("/v1/workspaces/branch", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      branch: input.branch,
      baseCommitSha: input.baseCommitSha,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
    if (!result.branch || !result.headCommitSha) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
    return result;
  }

  async checkpointCommit(input: { providerWorkspaceRef: string; branch: string; label: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderCheckpoint> {
    const result = await this.client.request<PiWorkspaceProviderCheckpoint>("/v1/workspaces/checkpoint", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      branch: input.branch,
      label: input.label,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
    if (!result.commitSha || !result.branch || !result.messageDigest) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
    return result;
  }

  async computeDiff(input: { providerWorkspaceRef: string; baseCommitSha: string; branch: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<PiWorkspaceProviderDiff> {
    const result = await this.client.request<PiWorkspaceProviderDiff>("/v1/workspaces/diff", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      baseCommitSha: input.baseCommitSha,
      branch: input.branch,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
    if (typeof result.diff !== "string" || !result.diffDigest || !result.baseCommitSha) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
    if (result.diff.length > 8_000_000) throw new Error("PI_WORKSPACE_DIFF_TOO_LARGE");
    return result;
  }

  async pushBranch(input: { providerWorkspaceRef: string; branch: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<{ branch: string; headCommitSha: string }> {
    const result = await this.client.request<{ branch: string; headCommitSha: string }>("/v1/workspaces/push", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      branch: input.branch,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
    if (!result.branch || !result.headCommitSha) throw new Error("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
    return result;
  }

  async cleanupWorkspace(input: { providerWorkspaceRef: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    await this.client.request("/v1/workspaces/cleanup", {
      providerWorkspaceRef: input.providerWorkspaceRef,
      credentialLeaseRef: input.credentialLeaseRef,
    }, input.context);
  }
}

export class FailClosedPiWorkspaceProvider implements PiWorkspaceProvider {
  readonly kind = "unavailable" as const;
  private unavailable(): never { throw new Error("PI_WORKSPACE_PROVIDER_UNAVAILABLE"); }
  authorizeRepository(): Promise<void> { return this.unavailable(); }
  prepareWorkspace(): Promise<PiWorkspaceProviderPreparation> { return this.unavailable(); }
  verifyBaseCommit(): Promise<void> { return this.unavailable(); }
  createEphemeralBranch(): Promise<PiWorkspaceProviderBranch> { return this.unavailable(); }
  checkpointCommit(): Promise<PiWorkspaceProviderCheckpoint> { return this.unavailable(); }
  computeDiff(): Promise<PiWorkspaceProviderDiff> { return this.unavailable(); }
  pushBranch(): Promise<{ branch: string; headCommitSha: string }> { return this.unavailable(); }
  cleanupWorkspace(): Promise<void> { return this.unavailable(); }
}

export class InMemoryPiGitCredentialBroker implements PiGitCredentialBroker {
  private readonly leases = new Map<string, PiCredentialScope>();

  async issueLease(input: { repository: PiRepositoryBinding; workspaceId: string; branch: string; ttlMs: number; context: PiWorkspaceContext }): Promise<{ leaseRef: string; scopeDigest: string; expiresAt: string }> {
    const scope = credentialScope(input.context);
    if (input.repository.tenantId !== input.context.tenantId) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (input.repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    assertEphemeralBranch(input.branch);
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 15 * 60 * 1000) throw new Error("PI_CREDENTIAL_TTL_INVALID");
    const leaseRef = `memory://git-lease/${randomUUID()}`;
    this.leases.set(leaseRef, scope);
    return {
      leaseRef,
      scopeDigest: digest(JSON.stringify({ ...scope, repositoryId: input.repository.id, workspaceId: input.workspaceId, branch: input.branch })),
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    };
  }

  async revokeLease(input: { leaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    assertLeaseRef(input.leaseRef);
    const scope = this.leases.get(input.leaseRef);
    if (!scope) return;
    if (!sameCredentialScope(scope, input.context)) throw new Error("PI_CREDENTIAL_SCOPE_MISMATCH");
    this.leases.delete(input.leaseRef);
  }
}

export class FailClosedPiGitCredentialBroker implements PiGitCredentialBroker {
  private unavailable(): never { throw new Error("PI_CREDENTIAL_BROKER_UNAVAILABLE"); }
  issueLease(): Promise<{ leaseRef: string; scopeDigest: string; expiresAt: string }> { return this.unavailable(); }
  revokeLease(): Promise<void> { return this.unavailable(); }
}

export class HttpPiGitCredentialBroker implements PiGitCredentialBroker {
  constructor(private readonly client: WorkspaceSupervisorClient) {}

  async issueLease(input: { repository: PiRepositoryBinding; workspaceId: string; branch: string; ttlMs: number; context: PiWorkspaceContext }): Promise<{ leaseRef: string; scopeDigest: string; expiresAt: string }> {
    assertCredentialContext(input.context);
    if (input.repository.tenantId !== input.context.tenantId) throw new Error("PI_REPOSITORY_NOT_FOUND");
    if (input.repository.status !== "active") throw new Error("PI_REPOSITORY_REVOKED");
    assertEphemeralBranch(input.branch);
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 15 * 60 * 1000) throw new Error("PI_CREDENTIAL_TTL_INVALID");
    const result = await this.client.request<{ leaseRef: string; scopeDigest: string; expiresAt: string }>("/v1/git/credential-leases", {
      repositoryId: input.repository.id,
      repositoryRef: input.repository.repositoryRef,
      workspaceId: input.workspaceId,
      branch: input.branch,
      ttlMs: input.ttlMs,
    }, input.context);
    if (!result.leaseRef || !result.expiresAt || !/^[a-f0-9]{64}$/i.test(result.scopeDigest)) throw new Error("PI_CREDENTIAL_BROKER_RESPONSE_INVALID");
    assertLeaseRef(result.leaseRef);
    return result;
  }

  async revokeLease(input: { leaseRef: string; context: PiWorkspaceContext }): Promise<void> {
    assertCredentialContext(input.context);
    assertLeaseRef(input.leaseRef);
    await this.client.request("/v1/git/credential-leases/revoke", { leaseRef: input.leaseRef }, input.context);
  }
}

export function createPiWorkspaceProvider(): PiWorkspaceProvider {
  if (process.env.NEXUS_PI_WORKSPACE_PROVIDER === "virtual" && process.env.NODE_ENV !== "production") return new VirtualPiWorkspaceProvider();
  const endpoint = process.env.NEXUS_PI_WORKSPACE_ENDPOINT;
  if (endpoint) {
    try { return new RemotePiWorkspaceProvider(new HttpWorkspaceSupervisorClient(endpoint)); } catch { return new FailClosedPiWorkspaceProvider(); }
  }
  return new FailClosedPiWorkspaceProvider();
}

export function createPiGitCredentialBroker(): PiGitCredentialBroker {
  if (process.env.NEXUS_PI_WORKSPACE_PROVIDER === "virtual" && process.env.NODE_ENV !== "production") return new InMemoryPiGitCredentialBroker();
  const endpoint = process.env.NEXUS_PI_CREDENTIAL_ENDPOINT;
  if (endpoint) {
    try { return new HttpPiGitCredentialBroker(new HttpWorkspaceSupervisorClient(endpoint)); } catch { return new FailClosedPiGitCredentialBroker(); }
  }
  return new FailClosedPiGitCredentialBroker();
}
