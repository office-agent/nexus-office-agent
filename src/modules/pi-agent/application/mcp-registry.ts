import { createPublicKey, randomUUID, verify as verifySignature, type KeyObject } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson, sha256 } from "@/src/modules/pi-agent/application/manifest";
import type {
  McpCredential,
  McpCredentialBroker,
  McpNetworkPolicy,
  McpProbeResult,
  McpRegistryStore,
  McpScope,
  McpServerRecord,
  McpServerRegistrationInput,
  McpToolBinding,
  McpToolCatalogItem,
  McpToolDefinition,
  McpTransport,
} from "@/src/modules/pi-agent/domain/mcp-contracts";
import { ManagedSecretClient } from "@/src/platform/secrets/managed-secret-client";
import { OpenBaoSecretClient } from "@/src/platform/secrets/openbao-secret-client";
import type { PiMcpBindingSnapshot } from "@/src/modules/pi-agent/domain/contracts";

export type McpServerSignatureInput = {
  serverId: string;
  version: string;
  digest: string;
  source: string;
  endpointRef: string;
  networkPolicy: McpNetworkPolicy;
};

export function canonicalMcpServerPayload(input: McpServerSignatureInput): string {
  return stableJson({
    kind: "mcp-server",
    serverId: input.serverId,
    version: input.version,
    digest: input.digest,
    source: input.source,
    endpointRef: input.endpointRef,
    networkPolicy: input.networkPolicy,
  });
}

export interface McpServerSignatureVerifier {
  verify(input: McpServerSignatureInput & { signature: string }): Promise<boolean>;
}

export class Ed25519McpServerSignatureVerifier implements McpServerSignatureVerifier {
  private readonly key: KeyObject;
  constructor(publicKey: string | KeyObject) { this.key = typeof publicKey === "string" ? createPublicKeyFromPem(publicKey) : publicKey; }
  async verify(input: McpServerSignatureInput & { signature: string }): Promise<boolean> {
    try { return verifySignature(null, Buffer.from(canonicalMcpServerPayload(input)), this.key, Buffer.from(input.signature, "base64url")); } catch { return false; }
  }
}

export class FailClosedMcpServerSignatureVerifier implements McpServerSignatureVerifier {
  async verify(): Promise<boolean> { return false; }
}

function createPublicKeyFromPem(publicKey: string): KeyObject { return createPublicKey(publicKey); }

function validSha(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function validId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function validVersion(value: string): boolean { return /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/.test(value); }
function validSecretRef(value: string): boolean { return /^secret:\/\/[a-zA-Z0-9/_-]{1,200}$/.test(value) && !value.includes(".."); }

function forbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (["localhost", "metadata", "metadata.google.internal", "instance-data"].includes(host)) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

export function validateMcpEndpoint(endpointRef: string, networkPolicy: McpNetworkPolicy, allowLocalhost = process.env.NODE_ENV !== "production"): URL {
  let url: URL;
  try { url = new URL(endpointRef); } catch { throw new Error("PI_MCP_ENDPOINT_INVALID"); }
  if (url.username || url.password || url.hash || url.search) throw new Error("PI_MCP_ENDPOINT_INVALID");
  if (url.protocol !== "https:" && !(allowLocalhost && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("PI_MCP_HTTPS_REQUIRED");
  if (forbiddenHostname(url.hostname) && !(allowLocalhost && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("PI_MCP_PRIVATE_ENDPOINT_DENIED");
  if (!networkPolicy.allowedHosts.includes(url.hostname)) throw new Error("PI_MCP_ENDPOINT_NOT_ALLOWLISTED");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!networkPolicy.allowedPorts.includes(port)) throw new Error("PI_MCP_PORT_NOT_ALLOWLISTED");
  return url;
}

export function validateMcpNetworkPolicy(policy: McpNetworkPolicy, allowLocalhost = process.env.NODE_ENV !== "production"): McpNetworkPolicy {
  const hosts = [...new Set(policy.allowedHosts.map((host) => host.trim().toLowerCase()))];
  const ports = [...new Set(policy.allowedPorts)];
  if (!hosts.length || hosts.length > 32 || hosts.some((host) => !/^[a-z0-9.-]{1,253}$/.test(host) || host.includes("*") || (forbiddenHostname(host) && !(allowLocalhost && ["localhost", "127.0.0.1"].includes(host))))) throw new Error("PI_MCP_NETWORK_POLICY_INVALID");
  if (!ports.length || ports.length > 16 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("PI_MCP_NETWORK_POLICY_INVALID");
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 30_000) throw new Error("PI_MCP_TIMEOUT_INVALID");
  if (!Number.isInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 1_024 || policy.maxResponseBytes > 20_000_000) throw new Error("PI_MCP_RESPONSE_LIMIT_INVALID");
  if (policy.proxyRef && !/^(?:proxy|egress):\/[a-zA-Z0-9/_-]{1,200}$/.test(policy.proxyRef)) throw new Error("PI_MCP_PROXY_REF_INVALID");
  if (process.env.NODE_ENV === "production" && !policy.proxyRef) throw new Error("PI_MCP_PROXY_REQUIRED");
  return { allowedHosts: hosts, allowedPorts: ports.sort((left, right) => left - right), timeoutMs: policy.timeoutMs, maxResponseBytes: policy.maxResponseBytes, ...(policy.proxyRef ? { proxyRef: policy.proxyRef } : {}) };
}

function validateJsonObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function riskRank(value: string): number { return Number(value.slice(1)); }

function normalizeTool(tool: McpToolDefinition): McpToolDefinition {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(tool.name)) throw new Error("PI_MCP_TOOL_NAME_INVALID");
  if (tool.name.includes("..") || tool.name.startsWith("/") || tool.name.endsWith("/")) throw new Error("PI_MCP_TOOL_NAME_INVALID");
  if (tool.description.length > 4_000) throw new Error("PI_MCP_TOOL_DESCRIPTION_INVALID");
  const inputSchema = validateJsonObject(tool.inputSchema, "PI_MCP_SCHEMA_INVALID");
  const schemaDigest = sha256(stableJson(inputSchema));
  if (tool.schemaDigest !== schemaDigest) throw new Error("PI_MCP_SCHEMA_DIGEST_INVALID");
  if (!Array.isArray(tool.requiredPermissions) || tool.requiredPermissions.length > 32 || tool.requiredPermissions.some((permission) => !/^[a-z][a-z0-9_.:-]{1,100}$/.test(permission))) throw new Error("PI_MCP_TOOL_PERMISSION_INVALID");
  if (!/^R[0-4]$/.test(tool.riskLevel) || riskRank(tool.riskLevel) > 4) throw new Error("PI_MCP_TOOL_RISK_INVALID");
  if (!["public", "internal", "confidential", "restricted"].includes(tool.dataClassification)) throw new Error("PI_MCP_TOOL_CLASSIFICATION_INVALID");
  return { ...tool, description: tool.description.trim(), inputSchema, requiredPermissions: [...new Set(tool.requiredPermissions)].sort() };
}

function schemaDigest(tools: McpToolDefinition[]): string { return sha256(stableJson(tools.map((tool) => normalizeTool(tool)).sort((left, right) => left.name.localeCompare(right.name)))); }

function scopeApplies(context: RequestContext, scope: McpScope): boolean {
  if (scope.type === "tenant") return true;
  if (scope.type === "user") return scope.actorId === context.actorId;
  return context.dataScopes.some((item) => item.type === "tenant" || (item.type === "project" && item.projectIds.includes(scope.projectId)));
}

export type McpRegistryServiceOptions = {
  store: McpRegistryStore;
  verifier: McpServerSignatureVerifier;
  transport?: McpTransport;
  credentialBroker?: McpCredentialBroker;
  registryVersion?: string;
  allowLocalhost?: boolean;
};

export type McpBindInput = {
  bindingId?: string;
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: string;
  exposedName?: string;
  allowedProfiles: string[];
  scope: McpScope;
  networkPolicyRef?: string;
};

export class McpRegistryService {
  readonly registryVersion: string;
  private readonly allowLocalhost: boolean;
  constructor(private readonly options: McpRegistryServiceOptions) {
    this.registryVersion = options.registryVersion ?? "mcp-registry-v1";
    this.allowLocalhost = options.allowLocalhost ?? process.env.NODE_ENV !== "production";
  }

  async registerServer(context: RequestContext, input: McpServerRegistrationInput): Promise<McpServerRecord> {
    assertPiPermission(context, "pi:mcp:admin");
    if (!validId(input.id) || !validVersion(input.version)) throw new Error("PI_MCP_SERVER_ID_INVALID");
    if (!input.source.trim() || input.source.length > 256) throw new Error("PI_MCP_SOURCE_INVALID");
    if (!validSha(input.digest)) throw new Error("PI_MCP_SERVER_DIGEST_INVALID");
    if (!input.signature || input.signature.length > 4096) throw new Error("PI_MCP_SERVER_SIGNATURE_INVALID");
    const networkPolicy = validateMcpNetworkPolicy(input.networkPolicy, this.allowLocalhost);
    validateMcpEndpoint(input.endpointRef, networkPolicy, this.allowLocalhost);
    if (input.credentialRef && (!validSecretRef(input.credentialRef) || !credentialRefBelongsToTenant(input.credentialRef, context.tenantId))) throw new Error("PI_MCP_CREDENTIAL_SCOPE_INVALID");
    const signed = await this.options.verifier.verify({
      serverId: input.id, version: input.version, digest: input.digest, source: input.source.trim(), endpointRef: input.endpointRef, networkPolicy, signature: input.signature,
    });
    if (!signed) throw new Error("PI_MCP_SIGNATURE_INVALID");
    const record: McpServerRecord = {
      id: input.id, tenantId: context.tenantId, version: input.version, source: input.source.trim(), endpointRef: input.endpointRef,
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}), ownerActorId: context.actorId,
      digest: input.digest, signature: input.signature, networkPolicy, approvalStatus: "pending", tools: [], circuitState: "closed", failureCount: 0, createdAt: new Date().toISOString(),
    };
    await this.options.store.putServer(record);
    return record;
  }

  async approveServer(context: RequestContext, serverId: string, version: string): Promise<McpServerRecord> {
    assertPiPermission(context, "pi:mcp:admin");
    const server = await this.requireServer(context, serverId, version);
    if (!server.schemaDigest || !server.tools.length) throw new Error("PI_MCP_SCHEMA_REQUIRED");
    if (server.approvalStatus === "revoked") throw new Error("PI_MCP_SERVER_REVOKED");
    const verified = await this.options.verifier.verify({ serverId: server.id, version: server.version, digest: server.digest, source: server.source, endpointRef: server.endpointRef, networkPolicy: server.networkPolicy, signature: server.signature });
    if (!verified) throw new Error("PI_MCP_SIGNATURE_INVALID");
    return this.options.store.updateServer(context, serverId, version, { approvalStatus: "approved" });
  }

  async revokeServer(context: RequestContext, serverId: string, version: string): Promise<McpServerRecord> {
    assertPiPermission(context, "pi:mcp:admin");
    const server = await this.requireServer(context, serverId, version);
    const revoked = await this.options.store.updateServer(context, serverId, version, { approvalStatus: "revoked", circuitState: "open", circuitOpenedUntil: new Date().toISOString() });
    for (const binding of await this.options.store.listBindings(context)) {
      if (binding.serverId === server.id && binding.serverVersion === server.version && binding.status === "approved") await this.options.store.updateBinding(context, binding.id, { status: "revoked" });
    }
    return revoked;
  }

  async probeCapabilities(context: RequestContext, serverId: string, version: string): Promise<McpServerRecord> {
    assertPiPermission(context, "pi:mcp:admin");
    if (!this.options.transport) throw new Error("PI_MCP_TRANSPORT_UNAVAILABLE");
    const server = await this.requireServer(context, serverId, version);
    if (server.approvalStatus === "revoked") throw new Error("PI_MCP_SERVER_REVOKED");
    validateMcpNetworkPolicy(server.networkPolicy, this.allowLocalhost);
    validateMcpEndpoint(server.endpointRef, server.networkPolicy, this.allowLocalhost);
    if (!await this.options.verifier.verify({ serverId: server.id, version: server.version, digest: server.digest, source: server.source, endpointRef: server.endpointRef, networkPolicy: server.networkPolicy, signature: server.signature })) throw new Error("PI_MCP_SIGNATURE_INVALID");
    const credential = await (this.options.credentialBroker ?? new NoCredentialMcpBroker()).resolve(context, server);
    const result = await this.options.transport.probe(server, credential, AbortSignal.timeout(server.networkPolicy.timeoutMs), context);
    return this.freezeToolSchema(context, serverId, version, normalizeProbeResult(result));
  }

  async freezeToolSchema(context: RequestContext, serverId: string, version: string, tools: McpToolDefinition[], expectedDigest?: string): Promise<McpServerRecord> {
    assertPiPermission(context, "pi:mcp:admin");
    const server = await this.requireServer(context, serverId, version);
    if (!await this.options.verifier.verify({ serverId: server.id, version: server.version, digest: server.digest, source: server.source, endpointRef: server.endpointRef, networkPolicy: server.networkPolicy, signature: server.signature })) throw new Error("PI_MCP_SIGNATURE_INVALID");
    const normalized = normalizeProbeResult({ tools });
    const digest = schemaDigest(normalized);
    if (expectedDigest && expectedDigest !== digest) throw new Error("PI_MCP_SCHEMA_DIGEST_INVALID");
    if (server.schemaDigest && server.schemaDigest !== digest) {
      await this.options.store.updateServer(context, serverId, version, { circuitState: "open", circuitOpenedUntil: new Date().toISOString() }).catch(() => undefined);
      throw new Error("PI_MCP_SCHEMA_DRIFT");
    }
    return this.options.store.updateServer(context, serverId, version, { schemaDigest: digest, tools: normalized, probedAt: new Date().toISOString(), circuitState: "closed", failureCount: 0, circuitOpenedUntil: null });
  }

  async bindTool(context: RequestContext, input: McpBindInput): Promise<McpToolBinding> {
    assertPiPermission(context, "pi:mcp:bind");
    if (input.bindingId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.bindingId)) throw new Error("PI_MCP_BINDING_ID_INVALID");
    const server = await this.requireServer(context, input.serverId, input.serverVersion);
    if (server.approvalStatus !== "approved") throw new Error("PI_MCP_SERVER_NOT_APPROVED");
    if (!server.schemaDigest || !validSha(input.schemaDigest)) throw new Error("PI_MCP_SCHEMA_VERSION_CONFLICT");
    const tool = server.tools.find((item) => item.name === input.toolName);
    if (!tool) throw new Error("PI_MCP_TOOL_NOT_FOUND");
    if (tool.schemaDigest !== input.schemaDigest) throw new Error("PI_MCP_SCHEMA_VERSION_CONFLICT");
    if (!Array.isArray(input.allowedProfiles) || input.allowedProfiles.length === 0 || input.allowedProfiles.length > 7 || input.allowedProfiles.some((profile) => !Object.prototype.hasOwnProperty.call({ coding: 1, review: 1, debug: 1, refactor: 1, office: 1, integration: 1, release: 1 }, profile))) throw new Error("PI_MCP_PROFILE_INVALID");
    validateScope(input.scope, context);
    const exposedName = input.exposedName ?? `mcp.${server.id}.${tool.name}`;
    if (exposedName !== `mcp.${server.id}.${tool.name}` || exposedName.length > 256) throw new Error("PI_MCP_EXPOSED_NAME_INVALID");
    const now = new Date().toISOString();
    const allowedProfiles = [...new Set(input.allowedProfiles)] as McpToolBinding["allowedProfiles"];
    const binding: McpToolBinding = {
      id: input.bindingId ?? randomUUID(), tenantId: context.tenantId, serverId: server.id, serverVersion: server.version, serverDigest: server.digest, toolName: tool.name,
      exposedName, inputSchema: tool.inputSchema, schemaDigest: tool.schemaDigest, requiredPermissions: tool.requiredPermissions, riskLevel: tool.riskLevel,
      dataClassification: tool.dataClassification, allowedProfiles, scope: input.scope,
      ...(input.networkPolicyRef ? { networkPolicyRef: input.networkPolicyRef } : {}), status: "approved", createdBy: context.actorId, createdAt: now, updatedAt: now,
    };
    await this.options.store.putBinding(binding);
    return binding;
  }

  async revokeBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding> {
    assertPiPermission(context, "pi:mcp:bind");
    const binding = await this.requireBinding(context, bindingId);
    return this.options.store.updateBinding(context, binding.id, { status: "revoked" });
  }

  async listTools(context: RequestContext, profile: string, bindingIds?: string[]): Promise<McpToolCatalogItem[]> {
    assertPiPermission(context, "pi:catalog:read");
    const resolved: McpToolCatalogItem[] = [];
    for (const binding of await this.options.store.listBindings(context)) {
      if (bindingIds && !bindingIds.includes(binding.id)) continue;
      if (binding.status !== "approved" || !binding.allowedProfiles.includes(profile as McpToolBinding["allowedProfiles"][number]) || !scopeApplies(context, binding.scope)) continue;
      const server = await this.options.store.getServer(context, binding.serverId, binding.serverVersion);
      if (!server || server.approvalStatus !== "approved" || server.circuitState === "open") continue;
      if (binding.serverDigest !== server.digest) continue;
      const verified = await this.options.verifier.verify({ serverId: server.id, version: server.version, digest: server.digest, source: server.source, endpointRef: server.endpointRef, networkPolicy: server.networkPolicy, signature: server.signature });
      if (!verified) continue;
      const tool = server.tools.find((item) => item.name === binding.toolName);
      if (!tool || tool.schemaDigest !== binding.schemaDigest || sha256(stableJson(binding.inputSchema)) !== binding.schemaDigest) continue;
      const { inputSchema, createdBy, ...catalog } = binding;
      void inputSchema;
      void createdBy;
      resolved.push({ ...catalog, inputSchemaDigest: sha256(stableJson(binding.inputSchema)) });
    }
    return resolved;
  }

  async listServers(context: RequestContext): Promise<McpServerRecord[]> {
    assertPiPermission(context, "pi:mcp:admin");
    return this.options.store.listServers(context);
  }

  async listBindings(context: RequestContext): Promise<McpToolBinding[]> {
    assertPiPermission(context, "pi:mcp:admin");
    return this.options.store.listBindings(context);
  }

  async resolveTools(context: RequestContext, profile: string, bindingIds?: string[]): Promise<McpToolCatalogItem[]> {
    return this.listTools(context, profile, bindingIds);
  }

  async resolveBindingSet(context: RequestContext, profile: string, bindingIds: string[]): Promise<{ bindings: PiMcpBindingSnapshot[]; servers: McpServerRecord[] }> {
    assertPiPermission(context, "pi:mcp:use");
    if (bindingIds.length > 32 || new Set(bindingIds).size !== bindingIds.length) throw new Error("PI_MCP_BINDING_SELECTION_INVALID");
    const bindings: PiMcpBindingSnapshot[] = [];
    const servers: McpServerRecord[] = [];
    for (const bindingId of bindingIds) {
      const resolved = await this.resolveBinding(context, { bindingId, profile });
      bindings.push({ bindingId: resolved.binding.id, serverId: resolved.server.id, serverVersion: resolved.server.version, serverDigest: resolved.server.digest, toolName: resolved.tool.name, exposedName: resolved.binding.exposedName, schemaDigest: resolved.binding.schemaDigest, riskLevel: resolved.binding.riskLevel, dataClassification: resolved.binding.dataClassification });
      if (!servers.some((server) => server.id === resolved.server.id && server.version === resolved.server.version)) servers.push(resolved.server);
    }
    return { bindings, servers };
  }

  async resolveBinding(context: RequestContext, input: { bindingId?: string; exposedName?: string; profile: string }): Promise<{ binding: McpToolBinding; server: McpServerRecord; tool: McpToolDefinition }> {
    const binding = input.bindingId ? await this.requireBinding(context, input.bindingId) : input.exposedName ? await this.options.store.getBindingByName(context, input.exposedName) : null;
    if (!binding) throw new Error("PI_MCP_BINDING_NOT_FOUND");
    if (binding.status !== "approved") throw new Error("PI_MCP_BINDING_REVOKED");
    if (!binding.allowedProfiles.includes(input.profile as McpToolBinding["allowedProfiles"][number])) throw new Error("PI_MCP_PROFILE_NOT_ALLOWED");
    if (!scopeApplies(context, binding.scope)) throw new Error("PI_MCP_SCOPE_DENIED");
    const server = await this.requireServer(context, binding.serverId, binding.serverVersion);
    if (server.approvalStatus !== "approved") throw new Error("PI_MCP_SERVER_NOT_APPROVED");
    if (server.circuitState === "open" && (!server.circuitOpenedUntil || new Date(server.circuitOpenedUntil) > new Date())) throw new Error("PI_MCP_CIRCUIT_OPEN");
    const tool = server.tools.find((item) => item.name === binding.toolName);
    if (binding.serverDigest !== server.digest || !server.schemaDigest || !tool || tool.schemaDigest !== binding.schemaDigest || sha256(stableJson(binding.inputSchema)) !== binding.schemaDigest) throw new Error("PI_MCP_SCHEMA_VERSION_CONFLICT");
    validateMcpNetworkPolicy(server.networkPolicy, this.allowLocalhost);
    validateMcpEndpoint(server.endpointRef, server.networkPolicy, this.allowLocalhost);
    const verified = await this.options.verifier.verify({ serverId: server.id, version: server.version, digest: server.digest, source: server.source, endpointRef: server.endpointRef, networkPolicy: server.networkPolicy, signature: server.signature });
    if (!verified) throw new Error("PI_MCP_SIGNATURE_INVALID");
    return { binding, server, tool };
  }

  async recordCircuitFailure(context: RequestContext, serverId: string, version: string): Promise<void> {
    if (this.options.store.recordCircuitFailure) {
      await this.options.store.recordCircuitFailure(context, serverId, version, 3, 30_000);
      return;
    }
    const server = await this.requireServer(context, serverId, version);
    const count = server.failureCount + 1;
    await this.options.store.updateServer(context, serverId, version, count >= 3 ? { failureCount: count, circuitState: "open", circuitOpenedUntil: new Date(Date.now() + 30_000).toISOString() } : { failureCount: count });
  }

  async recordCircuitSuccess(context: RequestContext, serverId: string, version: string): Promise<void> {
    await this.options.store.updateServer(context, serverId, version, { failureCount: 0, circuitState: "closed", circuitOpenedUntil: null });
  }

  async openCircuit(context: RequestContext, serverId: string, version: string, _reason = "manual"): Promise<McpServerRecord> {
    void _reason;
    assertPiPermission(context, "pi:mcp:admin");
    await this.requireServer(context, serverId, version);
    return this.options.store.updateServer(context, serverId, version, { circuitState: "open", circuitOpenedUntil: new Date(Date.now() + 30_000).toISOString() });
  }

  async refreshOAuth(context: RequestContext, serverId: string, version: string): Promise<void> {
    assertPiPermission(context, "pi:mcp:admin");
    const server = await this.requireServer(context, serverId, version);
    if (!server.credentialRef || !this.options.credentialBroker?.refreshOAuth) throw new Error("PI_MCP_OAUTH_REFRESH_UNAVAILABLE");
    await this.options.credentialBroker.refreshOAuth(context, server);
  }

  async resetCircuit(context: RequestContext, serverId: string, version: string): Promise<void> {
    assertPiPermission(context, "pi:mcp:admin");
    await this.requireServer(context, serverId, version);
    await this.options.store.updateServer(context, serverId, version, { failureCount: 0, circuitState: "closed", circuitOpenedUntil: null });
  }

  async getServer(context: RequestContext, serverId: string, version?: string): Promise<McpServerRecord> { return this.requireServer(context, serverId, version); }
  async getBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding> { return this.requireBinding(context, bindingId); }

  private async requireServer(context: RequestContext, serverId: string, version?: string): Promise<McpServerRecord> {
    const server = await this.options.store.getServer(context, serverId, version);
    if (!server) throw new Error("PI_MCP_SERVER_NOT_FOUND");
    return server;
  }

  private async requireBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding> {
    const binding = await this.options.store.getBinding(context, bindingId);
    if (!binding) throw new Error("PI_MCP_BINDING_NOT_FOUND");
    return binding;
  }
}

function normalizeProbeResult(result: McpProbeResult): McpToolDefinition[] {
  if (!result || !Array.isArray(result.tools) || result.tools.length > 256) throw new Error("PI_MCP_SCHEMA_INVALID");
  const tools = result.tools.map(normalizeTool);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("PI_MCP_SCHEMA_INVALID");
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

function validateScope(scope: McpScope, context: RequestContext): void {
  if (scope.type === "project" && (!scope.projectId || scope.projectId.length > 256)) throw new Error("PI_MCP_SCOPE_INVALID");
  if (scope.type === "user" && scope.actorId !== context.actorId) throw new Error("PI_MCP_SCOPE_INVALID");
}

export class NoCredentialMcpBroker implements McpCredentialBroker {
  async resolve(_context: RequestContext, server: McpServerRecord): Promise<McpCredential> {
    if (server.credentialRef) throw new Error("PI_MCP_CREDENTIAL_UNAVAILABLE");
    return { headers: {}, secretValues: [] };
  }
}

export class ManagedMcpCredentialBroker implements McpCredentialBroker {
  constructor(private readonly client: ManagedSecretClient) {}
  async resolve(context: RequestContext, server: McpServerRecord): Promise<McpCredential> {
    if (!server.credentialRef) return { headers: {}, secretValues: [] };
    if (!credentialRefBelongsToTenant(server.credentialRef, context.tenantId)) throw new Error("PI_MCP_CREDENTIAL_SCOPE_INVALID");
    const raw = await this.client.resolveString(server.credentialRef, `mcp:${server.id}:${server.version}`);
    return credentialFromSecret(raw);
  }
}

export class OpenBaoMcpCredentialBroker implements McpCredentialBroker {
  constructor(private readonly client: OpenBaoSecretClient) {}
  async resolve(context: RequestContext, server: McpServerRecord): Promise<McpCredential> {
    if (!server.credentialRef) return { headers: {}, secretValues: [] };
    if (!credentialRefBelongsToTenant(server.credentialRef, context.tenantId)) throw new Error("PI_MCP_CREDENTIAL_SCOPE_INVALID");
    return credentialFromSecret(await this.client.resolveString(server.credentialRef, `mcp:${server.id}:${server.version}`));
  }
}

function credentialFromSecret(raw: string): McpCredential {
  if (!raw || raw.length > 64_000) throw new Error("PI_MCP_CREDENTIAL_INVALID");
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; authorization?: unknown; headers?: unknown };
    if (parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)) {
      const headers = Object.fromEntries(Object.entries(parsed.headers as Record<string, unknown>)
        .filter(([key, value]) => typeof value === "string" && !/^(?:host|content-length|connection|transfer-encoding|x-nexus-tenant-id|x-nexus-actor-id|x-nexus-trace-id)$/i.test(key))
        .map(([key, value]) => [key, value as string]));
      return { headers, secretValues: [raw, ...Object.values(headers)] };
    }
    if (typeof parsed.authorization === "string") return { headers: { authorization: parsed.authorization }, secretValues: [raw, parsed.authorization] };
    if (typeof parsed.token === "string") return { headers: { authorization: `Bearer ${parsed.token}` }, secretValues: [raw, parsed.token] };
  } catch { /* treat a non-JSON secret as a bearer token */ }
  return { headers: { authorization: `Bearer ${raw}` }, secretValues: [raw] };
}

function credentialRefBelongsToTenant(reference: string, tenantId: string): boolean {
  return reference.startsWith(`secret://tenants/${tenantId}/`);
}

export function createMcpCredentialBroker(): McpCredentialBroker {
  if (process.env.SECRET_PROVIDER === "openbao" || process.env.OPENBAO_ADDR) return new OpenBaoMcpCredentialBroker(new OpenBaoSecretClient());
  if (process.env.SECRET_PROVIDER === "managed-http") return new ManagedMcpCredentialBroker(new ManagedSecretClient());
  return new NoCredentialMcpBroker();
}

export function createMcpRegistry(store: McpRegistryStore, options: Omit<McpRegistryServiceOptions, "store" | "verifier"> = {}): McpRegistryService {
  const publicKey = process.env.NEXUS_MCP_PUBLIC_KEY?.trim();
  const verifier = publicKey ? new Ed25519McpServerSignatureVerifier(publicKey) : new FailClosedMcpServerSignatureVerifier();
  return new McpRegistryService({ store, verifier, ...options });
}
