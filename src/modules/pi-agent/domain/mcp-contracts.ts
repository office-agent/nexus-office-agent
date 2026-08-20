import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";

export type McpApprovalStatus = "pending" | "approved" | "revoked";
export type McpCircuitState = "closed" | "open";
export type McpScope =
  | { type: "tenant" }
  | { type: "project"; projectId: string }
  | { type: "user"; actorId: string };
export type McpDataClassification = "public" | "internal" | "confidential" | "restricted";

export type McpNetworkPolicy = {
  allowedHosts: string[];
  allowedPorts: number[];
  timeoutMs: number;
  maxResponseBytes: number;
  proxyRef?: string;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaDigest: string;
  requiredPermissions: string[];
  riskLevel: PiRiskLevel;
  dataClassification: McpDataClassification;
};

export type McpServerRecord = {
  id: string;
  tenantId: string;
  version: string;
  source: string;
  endpointRef: string;
  credentialRef?: string;
  ownerActorId?: string;
  digest: string;
  signature: string;
  networkPolicy: McpNetworkPolicy;
  approvalStatus: McpApprovalStatus;
  schemaDigest?: string;
  tools: McpToolDefinition[];
  circuitState: McpCircuitState;
  failureCount: number;
  circuitOpenedUntil?: string;
  createdAt: string;
  probedAt?: string;
};

export type McpToolBinding = {
  id: string;
  tenantId: string;
  serverId: string;
  serverVersion: string;
  serverDigest: string;
  toolName: string;
  exposedName: string;
  inputSchema: Record<string, unknown>;
  schemaDigest: string;
  requiredPermissions: string[];
  riskLevel: PiRiskLevel;
  dataClassification: McpDataClassification;
  allowedProfiles: PiProfileId[];
  scope: McpScope;
  networkPolicyRef?: string;
  status: "approved" | "revoked";
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type McpToolCatalogItem = Omit<McpToolBinding, "inputSchema" | "createdBy"> & {
  inputSchemaDigest: string;
};

export type McpServerRegistrationInput = {
  id: string;
  version: string;
  source: string;
  endpointRef: string;
  credentialRef?: string;
  ownerActorId?: string;
  digest: string;
  signature: string;
  networkPolicy: McpNetworkPolicy;
};

export type McpRegistryStore = {
  putServer(record: McpServerRecord): Promise<void>;
  getServer(context: RequestContext, serverId: string, version?: string): Promise<McpServerRecord | null>;
  listServers(context: RequestContext): Promise<McpServerRecord[]>;
  updateServer(context: RequestContext, serverId: string, version: string, patch: Partial<Pick<McpServerRecord, "approvalStatus" | "schemaDigest" | "tools" | "circuitState" | "failureCount" | "probedAt">> & { circuitOpenedUntil?: string | null }): Promise<McpServerRecord>;
  recordCircuitFailure?(context: RequestContext, serverId: string, version: string, threshold: number, openForMs: number): Promise<McpServerRecord>;
  putBinding(binding: McpToolBinding): Promise<void>;
  getBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding | null>;
  getBindingByName(context: RequestContext, exposedName: string): Promise<McpToolBinding | null>;
  listBindings(context: RequestContext): Promise<McpToolBinding[]>;
  updateBinding(context: RequestContext, bindingId: string, patch: Partial<Pick<McpToolBinding, "status">>): Promise<McpToolBinding>;
};

export type McpCredential = {
  headers: Record<string, string>;
  secretValues: string[];
};

export interface McpCredentialBroker {
  resolve(context: RequestContext, server: McpServerRecord): Promise<McpCredential>;
  refreshOAuth?(context: RequestContext, server: McpServerRecord): Promise<void>;
}

export type McpProbeResult = { tools: McpToolDefinition[] };
export type McpCallResult = { content: unknown; isError?: boolean };

export interface McpTransport {
  probe(server: McpServerRecord, credential: McpCredential, signal: AbortSignal, context?: RequestContext): Promise<McpProbeResult>;
  call(server: McpServerRecord, tool: McpToolDefinition, arguments_: Record<string, unknown>, credential: McpCredential, signal: AbortSignal, context?: RequestContext): Promise<McpCallResult>;
}

export type McpEgressRequest = {
  server: McpServerRecord;
  credential: McpCredential;
  endpoint: URL;
  init: RequestInit;
  signal: AbortSignal;
  context?: RequestContext;
};

export interface McpEgressClient {
  request(input: McpEgressRequest): Promise<Response>;
}

export type McpCallAudit = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  bindingId: string;
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: string;
  inputDigest: string;
  outputDigest?: string;
  resultClassification: McpDataClassification;
  status: "authorized" | "succeeded" | "failed" | "denied" | "circuit_open";
  errorCode?: string;
  latencyMs?: number;
  traceId: string;
  createdAt: string;
};

export interface McpAuditStore {
  append(audit: McpCallAudit): Promise<void>;
}

export type McpAuditScopeReadiness =
  | { ready: true }
  | { ready: false; code: "PI_MCP_AUDIT_SCOPE_CONSTRAINT_MISSING" | "PI_MCP_AUDIT_SCOPE_CONSTRAINT_UNVALIDATED" };

export interface McpAuditScopeReadinessPort {
  check(): Promise<McpAuditScopeReadiness>;
}

export type McpInvocation = {
  context: RequestContext;
  profile: PiProfileId;
  bindingId?: string;
  exposedName?: string;
  arguments: Record<string, unknown>;
  sessionId: string;
  runId: string;
  expectedSchemaDigest?: string;
};

export function assertMcpExecutionScope(invocation: Pick<McpInvocation, "context" | "sessionId" | "runId">): void {
  if (!invocation.sessionId.trim() || !invocation.runId.trim()) throw new Error("PI_MCP_EXECUTION_SCOPE_REQUIRED");
  if (invocation.context.sessionId !== invocation.sessionId) throw new Error("PI_MCP_SESSION_SCOPE_MISMATCH");
}

export type McpAuthorizedCall = {
  binding: McpToolBinding;
  server: McpServerRecord;
  tool: McpToolDefinition;
  policyVersion: number;
};

export type McpToolExecutionResult = {
  ok: boolean;
  content?: unknown;
  errorCode?: string;
  resultClassification: McpDataClassification;
  outputDigest?: string;
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: string;
  latencyMs: number;
};
