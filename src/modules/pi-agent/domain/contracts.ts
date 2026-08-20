import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiResourceSnapshot } from "@/src/modules/pi-agent/domain/resource-contracts";

export type PiProfileId = "coding" | "review" | "debug" | "refactor" | "office" | "integration" | "release";
export type PiSessionStatus = "created" | "queued" | "running" | "awaiting_approval" | "cancelling" | "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown";
export type PiRiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";
export type PiNetworkPolicy = "none" | "allowlist" | "restricted";
export type PiSandboxStatus = "provisioning" | "running" | "terminating" | "completed" | "failed" | "destroyed" | "unknown";
export type PiSandboxProtocol = "tcp" | "udp";

export type PiSandboxLimits = {
  cpuMillis: number;
  memoryBytes: number;
  pids: number;
  diskBytes: number;
  maxDurationMs: number;
  maxOutputBytes: number;
};

export type PiEgressDestination = {
  host: string;
  ports: number[];
  protocols?: PiSandboxProtocol[];
};

export type PiEgressPolicy = {
  mode: PiNetworkPolicy;
  destinations?: PiEgressDestination[];
  proxyRef?: string;
};

export type PiCompiledEgressPolicy = {
  mode: PiNetworkPolicy;
  defaultAction: "deny";
  dnsMode: "deny" | "proxy-only";
  metadataBlocked: true;
  directEgress: false;
  destinations: PiEgressDestination[];
  proxyRef?: string;
  digest: string;
};

export type PiSandboxUsage = {
  cpuMillis: number;
  memoryBytesPeak: number;
  pidsPeak: number;
  diskBytes: number;
  outputBytes: number;
  collectedAt: string;
};
export type PiRunStatus = "queued" | "provisioning" | "running" | "awaiting_approval" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
export type PiRunCommandType = "prompt" | "interrupt" | "cancel" | "checkpoint";
export type PiRunCommandStatus = "accepted" | "queued" | "leased" | "acknowledged" | "cancel_requested" | "cancelled" | "unknown" | "dead_lettered";

export type PiSession = {
  id: string;
  tenantId: string;
  actorId: string;
  workspaceId: string;
  repositoryId?: string;
  baseRef?: string;
  baseCommit?: string;
  profile: PiProfileId;
  profileVersion: number;
  status: PiSessionStatus;
  modelPolicy: string;
  sandboxProfile: string;
  networkPolicy: PiNetworkPolicy;
  policyVersion: number;
  skillDigests: string[];
  mcpServerDigests: string[];
  mcpBindingIds: string[];
  mcpBindings: PiMcpBindingSnapshot[];
  resourceSnapshot?: PiResourceSnapshot;
  sandboxRunId: string;
  traceId: string;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type PiMcpBindingSnapshot = {
  bindingId: string;
  serverId: string;
  serverVersion: string;
  serverDigest: string;
  toolName: string;
  exposedName: string;
  schemaDigest: string;
  riskLevel: PiRiskLevel;
  dataClassification: "public" | "internal" | "confidential" | "restricted";
};

export type PiSessionEvent = {
  id: string;
  tenantId: string;
  sessionId: string;
  branchId?: string;
  sequence: number;
  type: string;
  payload: unknown;
  traceId: string;
  createdAt: string;
};

export type PiCheckpoint = {
  id: string;
  tenantId: string;
  sessionId: string;
  label: string;
  gitCommitSha?: string;
  diffDigest: string;
  snapshot: unknown;
  createdAt: string;
};

export type PiSessionCreateInput = {
  profile: PiProfileId;
  workspaceId: string;
  repositoryId?: string;
  baseRef?: string;
  baseCommit?: string;
  skillIds?: string[];
  packageIds?: string[];
  extensionIds?: string[];
  mcpBindingIds?: string[];
  modelPolicy?: string;
};

export type PiRunManifest = {
  schemaVersion: 1;
  tenantId: string;
  actorId: string;
  workspaceId: string;
  sessionId: string;
  sessionVersion: number;
  runId: string;
  traceId: string;
  repository?: {
    repositoryId: string;
    baseRef?: string;
    baseCommit?: string;
    ephemeralBranch?: string;
  };
  profile: { id: PiProfileId; version: number; digest: string };
  resourceSnapshot: {
    schemaVersion: number;
    registryVersion: string;
    resolvedAt?: string;
    skillDigests: string[];
    extensionDigests: string[];
    packageDigests: string[];
    mcpServerDigests: string[];
  };
  toolSnapshot: { names: string[]; policyVersion: number };
  mcpBindings: PiMcpBindingSnapshot[];
  modelPolicy: { id: string; version: number; dataClassification: "public" | "internal" | "confidential" | "restricted" };
  sandbox: { profile: string; provider: "virtual" | "firecracker" | "kata" | "unavailable"; networkPolicy: PiNetworkPolicy };
  quota: { maxDurationMs: number; maxOutputBytes: number };
  policyVersion: number;
  promptDigest: string;
  manifestDigest: string;
  controllerSignature: string;
  createdAt: string;
  expiresAt: string;
};

export type PiRunCommand = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  type: PiRunCommandType;
  payload: { message?: string; reason?: string };
  idempotencyKey: string;
  status: PiRunCommandStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastErrorCode?: string;
  lastErrorDigest?: string;
  createdAt: string;
  updatedAt: string;
};

export type PiRunLease = PiRunCommand & {
  status: "leased";
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  /** True when this claim recovered a command whose previous lease expired. */
  reclaimedFromExpiredLease?: boolean;
};

export type PiRunEnqueueResult = { command: PiRunCommand; created: boolean };

export type PiRunLeaseRequest = { workerId: string; leaseMs: number; maxTenantConcurrency?: number; now?: Date };
export type PiRunFailure = { code: string; digest: string };
export type PiRunBacklogQuery = {
  statuses?: PiRunCommandStatus[];
  limit?: number;
};

export interface PiRunStore {
  createRun(manifest: PiRunManifest, command: PiRunCommand): Promise<PiRunEnqueueResult>;
  createManifest(manifest: PiRunManifest): Promise<void>;
  getManifest(context: RequestContext, runId: string): Promise<PiRunManifest | null>;
  getRunStatus(context: RequestContext, runId: string): Promise<PiRunStatus | null>;
  enqueue(command: PiRunCommand): Promise<PiRunEnqueueResult>;
  getCommand(context: RequestContext, commandId: string): Promise<PiRunCommand | null>;
  updateRunStatus(tenantId: string, runId: string, status: PiRunStatus, now?: Date): Promise<boolean>;
  updateRunStatusForLease(lease: PiRunLease, status: PiRunStatus, now?: Date): Promise<boolean>;
  isLeaseActive(lease: PiRunLease, now?: Date): Promise<boolean>;
  claim(tenantId: string, request: PiRunLeaseRequest): Promise<PiRunLease | null>;
  renew(lease: PiRunLease, workerId: string, leaseMs: number, now?: Date): Promise<boolean>;
  /** Release a claimed command back to the queue without consuming another attempt. */
  release(lease: PiRunLease, availableAt: Date, now?: Date): Promise<boolean>;
  /** Atomically mark the Run completed and acknowledge its command. */
  complete(lease: PiRunLease, now?: Date): Promise<boolean>;
  /** Atomically mark the Run failed and dead-letter its command. */
  fail(lease: PiRunLease, failure: PiRunFailure, now?: Date): Promise<boolean>;
  /** Record a terminal dead-letter result without allowing an old lease to mutate it. */
  deadLetter(lease: PiRunLease, failure: PiRunFailure, now?: Date): Promise<boolean>;
  acknowledge(lease: PiRunLease, status: "acknowledged" | "cancelled" | "unknown" | "dead_lettered", now?: Date): Promise<boolean>;
  requeue(lease: PiRunLease, failure: PiRunFailure, availableAt: Date, now?: Date): Promise<"queued" | "dead_lettered" | null>;
  markUnknown(lease: PiRunLease, failure: PiRunFailure, now?: Date): Promise<boolean>;
  requestCancel(context: RequestContext, runId: string, reason: string, idempotencyKey: string, type?: "cancel" | "interrupt"): Promise<PiRunEnqueueResult>;
  listCommands(context: RequestContext, sessionId: string): Promise<PiRunCommand[]>;
  listBacklog(tenantId: string, query?: PiRunBacklogQuery): Promise<PiRunCommand[]>;
}

export type PiSandboxSpec = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  workspaceId: string;
  profile: PiProfileId;
  repositoryId?: string;
  baseCommit?: string;
  networkPolicy: PiNetworkPolicy;
  runId?: string;
  imageDigest?: string;
  limits?: PiSandboxLimits;
  egressPolicy?: PiEgressPolicy;
};

export type PiSandbox = {
  id: string;
  root: string;
  provider: "virtual" | "firecracker" | "kata" | "unavailable";
  /**
   * Explicit execution-location assertion. A provider label alone does not
   * prove that the current Pi process is running inside the Guest VM.
   */
  executionBoundary?: "host" | "guest";
  tenantId?: string;
  actorId?: string;
  sessionId?: string;
  workspaceId?: string;
  runId?: string;
};

export type PiSandboxFile = {
  path: string;
  content: string;
  digest: string;
};

export type PiSandboxResult = {
  ok: boolean;
  output: string;
  exitCode?: number;
  errorCode?: string;
};

export interface PiSandboxProvider {
  readonly kind: PiSandbox["provider"];
  create(spec: PiSandboxSpec, signal?: AbortSignal): Promise<PiSandbox>;
  mountWorkspace(sandbox: PiSandbox, mount: PiWorkspaceMount, signal?: AbortSignal): Promise<void>;
  setLimits(sandbox: PiSandbox, limits: PiSandboxLimits, signal?: AbortSignal): Promise<void>;
  applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy, signal?: AbortSignal): Promise<void>;
  read(sandbox: PiSandbox, path: string): Promise<PiSandboxFile>;
  list(sandbox: PiSandbox, path: string): Promise<string[]>;
  write(sandbox: PiSandbox, path: string, content: string): Promise<PiSandboxFile>;
  applyPatch(sandbox: PiSandbox, path: string, oldText: string, newText: string): Promise<PiSandboxFile>;
  run(sandbox?: PiSandbox, command?: string, signal?: AbortSignal): Promise<PiSandboxResult>;
  snapshot(sandbox: PiSandbox): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }>;
  collectUsage(sandbox: PiSandbox): Promise<PiSandboxUsage>;
  terminate(sandbox: PiSandbox, reason: string): Promise<void>;
  destroy(sandbox: PiSandbox): Promise<void>;
  verifyDestroyed(sandbox: PiSandbox): Promise<boolean>;
}

export type PiWorkspaceMount = {
  sourceRef: string;
  targetPath: string;
  readOnly: boolean;
  contentDigest?: string;
};

export type PiSandboxRunRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  profile: PiProfileId;
  provider: PiSandbox["provider"];
  providerSandboxId?: string;
  imageDigest?: string;
  networkPolicy: PiNetworkPolicy;
  networkPolicySpec: PiCompiledEgressPolicy;
  networkPolicyDigest: string;
  limits: PiSandboxLimits;
  status: PiSandboxStatus;
  usage?: PiSandboxUsage;
  failureCode?: string;
  terminationReason?: string;
  destroyVerified: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export interface PiSandboxRunStore {
  create(record: PiSandboxRunRecord): Promise<void>;
  get(context: RequestContext, sandboxRunId: string): Promise<PiSandboxRunRecord | null>;
  getByRun(context: RequestContext, runId: string): Promise<PiSandboxRunRecord | null>;
  transition(context: RequestContext, sandboxRunId: string, status: PiSandboxStatus, patch?: Partial<Pick<PiSandboxRunRecord, "providerSandboxId" | "usage" | "failureCode" | "terminationReason" | "destroyVerified" | "startedAt" | "completedAt" | "updatedAt">>): Promise<PiSandboxRunRecord>;
  list(context: RequestContext, sessionId: string): Promise<PiSandboxRunRecord[]>;
}

export interface PiSessionStore {
  createSession(session: PiSession): Promise<void>;
  getSession(context: RequestContext, sessionId: string): Promise<PiSession | null>;
  listSessions(context: RequestContext): Promise<PiSession[]>;
  updateSession(context: RequestContext, sessionId: string, patch: Partial<Pick<PiSession, "status" | "lastEventSequence" | "updatedAt">>): Promise<PiSession>;
  appendEvent(context: RequestContext, sessionId: string, event: Omit<PiSessionEvent, "id" | "sequence" | "createdAt" | "tenantId" | "sessionId">): Promise<PiSessionEvent>;
  getEvents(context: RequestContext, sessionId: string, afterSequence: number, limit: number): Promise<PiSessionEvent[]>;
  createCheckpoint(context: RequestContext, checkpoint: PiCheckpoint): Promise<void>;
  listCheckpoints(context: RequestContext, sessionId: string): Promise<PiCheckpoint[]>;
}
