import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiCheckpoint, PiProfileId, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";

export type PiRepositoryProvider = "forgejo" | "github" | "gitlab" | "other";
export type PiWorkspaceStatus = "preparing" | "ready" | "checkpointing" | "destroying" | "destroyed" | "failed" | "unknown";
export type PiCredentialLeaseStatus = "active" | "revoked" | "expired";
export type PiArtifactType = "diff" | "test_report" | "scan_report" | "build" | "patch" | "log";
export type PiArtifactClassification = "public" | "internal" | "confidential" | "restricted";
export type PiArtifactStatus = "active" | "revoked" | "expired";
export type PiDownloadGrantStatus = "active" | "revoked" | "expired";

export type PiRepositoryBinding = {
  id: string;
  tenantId: string;
  workspaceId: string;
  provider: PiRepositoryProvider;
  repositoryRef: string;
  defaultBranch: string;
  credentialRef: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt?: string;
};

export type PiWorkspaceRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  repositoryId: string;
  provider: PiRepositoryProvider;
  repositoryRef: string;
  baseRef: string;
  baseCommitSha: string;
  ephemeralBranch: string;
  status: PiWorkspaceStatus;
  providerWorkspaceRef?: string;
  headCommitSha?: string;
  workspaceDigest?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  destroyedAt?: string;
};

export type PiGitCredentialLease = {
  id: string;
  tenantId: string;
  actorId: string;
  workspaceId: string;
  repositoryId: string;
  branch: string;
  scopeDigest: string;
  leaseRef: string;
  status: PiCredentialLeaseStatus;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
};

export type PiGitCommit = {
  commitSha: string;
  branch: string;
  messageDigest: string;
  createdAt: string;
};

export type PiWorkspaceDiff = {
  baseCommitSha: string;
  headCommitSha?: string;
  diffDigest: string;
  diff: string;
  truncated: boolean;
  artifactId?: string;
};

export type PiWorkspaceArtifact = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId?: string;
  workspaceId?: string;
  type: PiArtifactType;
  fileName: string;
  mediaType: string;
  storageRef: string;
  objectVersion: string;
  contentDigest: string;
  sizeBytes: number;
  classification: PiArtifactClassification;
  version: number;
  status: PiArtifactStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

export type PiDownloadGrant = {
  id: string;
  tenantId: string;
  actorId: string;
  artifactId: string;
  artifactVersion: number;
  grantRef: string;
  url: string;
  status: PiDownloadGrantStatus;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
};

export type PiWorkspaceContext = RequestContext & { runId: string };

export type PiObjectStorageScope = Pick<PiWorkspaceContext, "tenantId" | "actorId" | "sessionId" | "runId" | "traceId">;

export type PiWorkspacePreparationInput = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  repositoryId: string;
  baseRef: string;
  baseCommitSha: string;
  profile: PiProfileId;
};

export type PiWorkspaceProviderPreparation = {
  providerWorkspaceRef: string;
  workspaceDigest: string;
};

export type PiWorkspaceProviderBranch = {
  branch: string;
  headCommitSha: string;
};

export type PiWorkspaceProviderCheckpoint = PiGitCommit;

export type PiWorkspaceProviderDiff = {
  baseCommitSha: string;
  headCommitSha?: string;
  diff: string;
  diffDigest: string;
};

export interface PiWorkspaceProvider {
  readonly kind: "virtual" | "remote" | "unavailable";
  authorizeRepository(input: { repository: PiRepositoryBinding; context: PiWorkspaceContext }): Promise<void>;
  prepareWorkspace(input: {
    repository: PiRepositoryBinding;
    baseRef: string;
    baseCommitSha: string;
    ephemeralBranch: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<PiWorkspaceProviderPreparation>;
  verifyBaseCommit(input: {
    providerWorkspaceRef: string;
    baseRef: string;
    expectedCommitSha: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<void>;
  createEphemeralBranch(input: {
    providerWorkspaceRef: string;
    branch: string;
    baseCommitSha: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<PiWorkspaceProviderBranch>;
  checkpointCommit(input: {
    providerWorkspaceRef: string;
    branch: string;
    label: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<PiWorkspaceProviderCheckpoint>;
  computeDiff(input: {
    providerWorkspaceRef: string;
    baseCommitSha: string;
    branch: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<PiWorkspaceProviderDiff>;
  pushBranch(input: {
    providerWorkspaceRef: string;
    branch: string;
    credentialLeaseRef: string;
    context: PiWorkspaceContext;
  }): Promise<{ branch: string; headCommitSha: string }>;
  cleanupWorkspace(input: { providerWorkspaceRef: string; credentialLeaseRef: string; context: PiWorkspaceContext }): Promise<void>;
}

export interface PiGitCredentialBroker {
  issueLease(input: {
    repository: PiRepositoryBinding;
    workspaceId: string;
    branch: string;
    ttlMs: number;
    context: PiWorkspaceContext;
  }): Promise<{ leaseRef: string; scopeDigest: string; expiresAt: string }>;
  revokeLease(input: { leaseRef: string; context: PiWorkspaceContext }): Promise<void>;
}

export type PiArtifactWriteInput = {
  scope: PiObjectStorageScope;
  artifactId: string;
  version: number;
  bytes: Uint8Array;
  mediaType: string;
  classification: PiArtifactClassification;
};

export interface PiObjectStorageGateway {
  put(input: PiArtifactWriteInput): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }>;
  issueDownloadGrant(input: {
    scope: PiObjectStorageScope;
    artifactId: string;
    version: number;
    storageRef: string;
    ttlMs: number;
  }): Promise<{ grantRef: string; url: string; expiresAt: string }>;
  revokeDownloadGrant(input: { scope: PiObjectStorageScope; grantRef: string }): Promise<void>;
  deleteObject(input: { scope: PiObjectStorageScope; artifactId: string; version: number; storageRef: string }): Promise<void>;
}

export interface PiWorkspaceStore {
  getRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding | null>;
  putRepository(binding: PiRepositoryBinding): Promise<void>;
  createWorkspace(record: PiWorkspaceRecord): Promise<void>;
  getWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord | null>;
  getWorkspaceForRun(context: RequestContext, runId: string): Promise<PiWorkspaceRecord | null>;
  transitionWorkspace(
    context: RequestContext,
    workspaceRecordId: string,
    status: PiWorkspaceStatus,
    patch?: Partial<Pick<PiWorkspaceRecord, "providerWorkspaceRef" | "headCommitSha" | "workspaceDigest" | "failureCode" | "updatedAt" | "destroyedAt">>,
  ): Promise<PiWorkspaceRecord>;
  listWorkspaces(context: RequestContext, sessionId: string): Promise<PiWorkspaceRecord[]>;
  createCredentialLease(lease: PiGitCredentialLease): Promise<void>;
  getCredentialLease(context: RequestContext, leaseId: string): Promise<PiGitCredentialLease | null>;
  getCredentialLeaseForWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiGitCredentialLease | null>;
  revokeCredentialLease(context: RequestContext, leaseId: string, now?: Date): Promise<PiGitCredentialLease>;
  createArtifact(artifact: PiWorkspaceArtifact): Promise<void>;
  getArtifact(context: RequestContext, artifactId: string, version?: number): Promise<PiWorkspaceArtifact | null>;
  listArtifacts(context: RequestContext, sessionId: string): Promise<PiWorkspaceArtifact[]>;
  expireArtifacts(context: RequestContext, now?: Date): Promise<number>;
  createDownloadGrant(grant: PiDownloadGrant): Promise<void>;
  getDownloadGrant(context: RequestContext, grantId: string): Promise<PiDownloadGrant | null>;
  revokeDownloadGrant(context: RequestContext, grantId: string, now?: Date): Promise<PiDownloadGrant>;
}

export type PiWorkspaceServiceDependencies = {
  store: PiWorkspaceStore;
  provider: PiWorkspaceProvider;
  credentialBroker: PiGitCredentialBroker;
  objectStorage: PiObjectStorageGateway;
  sessionStore?: PiSessionStore;
};

export type PiWorkspaceCheckpointResult = {
  workspace: PiWorkspaceRecord;
  commit: PiGitCommit;
  diff: PiWorkspaceDiff;
  checkpoint?: PiCheckpoint;
};
