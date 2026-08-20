import type { PiArtifactClassification, PiRepositoryBinding, PiWorkspaceContext } from "@/src/modules/pi-agent/domain/workspace-contracts";

export type PiWorkspaceSupervisorConfig = {
  rootDirectory: string;
  forgejoBaseUrl: string;
  forgejoUsername: string;
  forgejoToken: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3Region: string;
  publicBaseUrl: string;
  stateFile?: string;
  maxBodyBytes?: number;
};

export type PiWorkspaceSupervisorContext = Pick<PiWorkspaceContext, "tenantId" | "actorId" | "sessionId" | "runId" | "traceId">;

export type PiWorkspaceLease = {
  leaseRef: string;
  scope: PiWorkspaceSupervisorContext;
  repositoryId: string;
  repositoryRef: string;
  workspaceId: string;
  branch: string;
  expiresAt: string;
  username: string;
  token: string;
};

export type PiSupervisorWorkspace = {
  id: string;
  workspaceId: string;
  providerWorkspaceRef: string;
  directory: string;
  repository: PiRepositoryBinding;
  context: PiWorkspaceSupervisorContext;
  baseRef: string;
  baseCommitSha: string;
  branch?: string;
  headCommitSha?: string;
};

export type PiSupervisorObject = {
  storageRef: string;
  objectVersion: string;
  scope: PiWorkspaceSupervisorContext;
  artifactId: string;
  version: number;
  sizeBytes: number;
  contentDigest: string;
  mediaType: string;
  classification: PiArtifactClassification;
};

export type PiSupervisorDownloadGrant = {
  grantRef: string;
  object: PiSupervisorObject;
  expiresAt: string;
};

export type PiWorkspaceSupervisorReadiness = {
  ready: boolean;
  code?: string;
};

export type PiWorkspaceSupervisorPersistedLease = Omit<PiWorkspaceLease, "username" | "token">;

export type PiWorkspaceSupervisorPersistedGrant = {
  grantRef: string;
  storageRef: string;
  expiresAt: string;
};

/**
 * The durable Supervisor state deliberately contains metadata only. Provider
 * credentials are reconstructed from the process secret lease and are never
 * part of this document.
 */
export type PiWorkspaceSupervisorState = {
  schemaVersion: 1;
  leases: PiWorkspaceSupervisorPersistedLease[];
  workspaces: PiSupervisorWorkspace[];
  objects: PiSupervisorObject[];
  grants: PiWorkspaceSupervisorPersistedGrant[];
};
