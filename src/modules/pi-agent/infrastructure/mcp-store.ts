import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  McpApprovalStatus,
  McpAuditStore,
  McpAuditScopeReadinessPort,
  McpCallAudit,
  McpCircuitState,
  McpDataClassification,
  McpNetworkPolicy,
  McpRegistryStore,
  McpScope,
  McpServerRecord,
  McpToolBinding,
  McpToolDefinition,
} from "@/src/modules/pi-agent/domain/mcp-contracts";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function optionalIso(value: unknown): string | undefined { return value === null || value === undefined ? undefined : iso(value); }

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function networkPolicy(value: unknown): McpNetworkPolicy {
  const record = jsonObject(value);
  return {
    allowedHosts: jsonArray<string>(record.allowedHosts ?? record.allowed_hosts),
    allowedPorts: jsonArray<number>(record.allowedPorts ?? record.allowed_ports),
    timeoutMs: Number(record.timeoutMs ?? record.timeout_ms ?? 5_000),
    maxResponseBytes: Number(record.maxResponseBytes ?? record.max_response_bytes ?? 1_000_000),
    ...((typeof record.proxyRef === "string" || typeof record.proxy_ref === "string") ? { proxyRef: String(record.proxyRef ?? record.proxy_ref) } : {}),
  };
}

function toolFromValue(value: unknown): McpToolDefinition {
  const record = jsonObject(value);
  return {
    name: String(record.name),
    description: String(record.description ?? ""),
    inputSchema: jsonObject(record.inputSchema ?? record.input_schema),
    schemaDigest: String(record.schemaDigest ?? record.schema_digest),
    requiredPermissions: jsonArray<string>(record.requiredPermissions ?? record.required_permissions),
    riskLevel: record.riskLevel as PiRiskLevel,
    dataClassification: record.dataClassification as McpDataClassification,
  };
}

function serverFromRow(row: Row): McpServerRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    version: String(row.version),
    source: String(row.source),
    endpointRef: String(row.endpoint_ref),
    ...((row.credential_ref || row.credential_ref === "") ? { credentialRef: String(row.credential_ref) } : {}),
    ...((row.owner_actor_id || row.owner_actor_id === "") ? { ownerActorId: String(row.owner_actor_id) } : {}),
    digest: String(row.digest),
    signature: String(row.signature ?? ""),
    networkPolicy: networkPolicy(row.network_policy),
    approvalStatus: row.approval_status as McpApprovalStatus,
    ...((row.schema_digest || row.schema_digest === "") ? { schemaDigest: String(row.schema_digest) } : {}),
    tools: jsonArray<unknown>(row.tool_schema).map(toolFromValue),
    circuitState: (row.circuit_state ?? "closed") as McpCircuitState,
    failureCount: Number(row.failure_count ?? 0),
    ...((row.circuit_opened_until || row.circuit_opened_until === 0) ? { circuitOpenedUntil: optionalIso(row.circuit_opened_until) } : {}),
    createdAt: iso(row.created_at),
    ...((row.probed_at || row.probed_at === 0) ? { probedAt: optionalIso(row.probed_at) } : {}),
  };
}

function scopeFromRow(row: Row): McpScope {
  const type = String(row.scope_type ?? "tenant");
  if (type === "project") return { type, projectId: String(row.scope_id) };
  if (type === "user") return { type, actorId: String(row.scope_id) };
  return { type: "tenant" };
}

function bindingFromRow(row: Row): McpToolBinding {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    serverId: String(row.server_id),
    serverVersion: String(row.server_version),
    serverDigest: String(row.server_digest ?? ""),
    toolName: String(row.tool_name),
    exposedName: String(row.exposed_name),
    inputSchema: jsonObject(row.input_schema),
    schemaDigest: String(row.schema_digest ?? ""),
    requiredPermissions: jsonArray<string>(row.required_permissions),
    riskLevel: row.risk_level as PiRiskLevel,
    dataClassification: row.data_classification as McpDataClassification,
    allowedProfiles: jsonArray<PiProfileId>(row.allowed_profiles),
    scope: scopeFromRow(row),
    ...((row.network_policy_ref || row.network_policy_ref === "") ? { networkPolicyRef: String(row.network_policy_ref) } : {}),
    status: row.status as McpToolBinding["status"],
    ...((row.created_by || row.created_by === "") ? { createdBy: String(row.created_by) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}

export class InMemoryMcpRegistryStore implements McpRegistryStore {
  private readonly servers = new Map<string, McpServerRecord>();
  private readonly bindings = new Map<string, McpToolBinding>();

  async putServer(record: McpServerRecord): Promise<void> {
    const key = `${record.tenantId}:${record.id}:${record.version}`;
    if (this.servers.has(key)) throw new Error("PI_MCP_SERVER_DUPLICATE");
    this.servers.set(key, clone(record));
  }

  async getServer(context: RequestContext, serverId: string, version?: string): Promise<McpServerRecord | null> {
    const values = [...this.servers.values()]
      .filter((server) => server.tenantId === context.tenantId && server.id === serverId && (!version || server.version === version))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return values[0] ? clone(values[0]) : null;
  }

  async listServers(context: RequestContext): Promise<McpServerRecord[]> {
    return [...this.servers.values()].filter((server) => server.tenantId === context.tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async updateServer(context: RequestContext, serverId: string, version: string, patch: Partial<Pick<McpServerRecord, "approvalStatus" | "schemaDigest" | "tools" | "circuitState" | "failureCount" | "probedAt">> & { circuitOpenedUntil?: string | null }): Promise<McpServerRecord> {
    const key = `${context.tenantId}:${serverId}:${version}`;
    const current = this.servers.get(key);
    if (!current) throw new Error("PI_MCP_SERVER_NOT_FOUND");
    const updated = clone({ ...current, ...patch, ...(patch.circuitOpenedUntil === null ? { circuitOpenedUntil: undefined } : {}) }) as McpServerRecord;
    if (patch.circuitOpenedUntil === null) delete updated.circuitOpenedUntil;
    this.servers.set(key, updated);
    return updated;
  }

  async recordCircuitFailure(context: RequestContext, serverId: string, version: string, threshold: number, openForMs: number): Promise<McpServerRecord> {
    const current = await this.getServer(context, serverId, version);
    if (!current) throw new Error("PI_MCP_SERVER_NOT_FOUND");
    const failureCount = current.failureCount + 1;
    return this.updateServer(context, serverId, version, failureCount >= threshold
      ? { failureCount, circuitState: "open", circuitOpenedUntil: new Date(Date.now() + openForMs).toISOString() }
      : { failureCount });
  }

  async putBinding(binding: McpToolBinding): Promise<void> {
    if (this.bindings.has(binding.id)) throw new Error("PI_MCP_BINDING_DUPLICATE");
    if ([...this.bindings.values()].some((item) => item.tenantId === binding.tenantId && item.exposedName === binding.exposedName && item.status === "approved")) throw new Error("PI_MCP_BINDING_DUPLICATE");
    this.bindings.set(binding.id, clone(binding));
  }

  async getBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding | null> {
    const binding = this.bindings.get(bindingId);
    return binding?.tenantId === context.tenantId ? clone(binding) : null;
  }

  async getBindingByName(context: RequestContext, exposedName: string): Promise<McpToolBinding | null> {
    const binding = [...this.bindings.values()].find((item) => item.tenantId === context.tenantId && item.exposedName === exposedName && item.status === "approved");
    return binding ? clone(binding) : null;
  }

  async listBindings(context: RequestContext): Promise<McpToolBinding[]> {
    return [...this.bindings.values()].filter((binding) => binding.tenantId === context.tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async updateBinding(context: RequestContext, bindingId: string, patch: Partial<Pick<McpToolBinding, "status">>): Promise<McpToolBinding> {
    const current = this.bindings.get(bindingId);
    if (!current || current.tenantId !== context.tenantId) throw new Error("PI_MCP_BINDING_NOT_FOUND");
    const updated = clone({ ...current, ...patch, updatedAt: new Date().toISOString() });
    this.bindings.set(bindingId, updated);
    return updated;
  }
}

export class PostgresMcpRegistryStore implements McpRegistryStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }
  private systemContext(tenantId: string, traceId: string): RequestContext {
    return { tenantId, actorId: "00000000-0000-0000-0000-000000000000", sessionId: "system", channel: "system", traceId, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] };
  }

  async putServer(record: McpServerRecord): Promise<void> {
    await this.scoped(this.systemContext(record.tenantId, record.id), async (db) => {
      await db.query(
        `INSERT INTO mcp_servers
          (id,tenant_id,version,digest,source,endpoint_ref,network_policy,approval_status,owner_actor_id,credential_ref,signature,schema_digest,tool_schema,circuit_state,failure_count,circuit_opened_until,probed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [record.id, record.tenantId, record.version, record.digest, record.source, record.endpointRef, JSON.stringify(record.networkPolicy), record.approvalStatus,
          record.ownerActorId ?? null, record.credentialRef ?? null, record.signature, record.schemaDigest ?? null, JSON.stringify(record.tools), record.circuitState,
          record.failureCount, record.circuitOpenedUntil ? new Date(record.circuitOpenedUntil) : null, record.probedAt ? new Date(record.probedAt) : null],
      );
    });
  }

  async getServer(context: RequestContext, serverId: string, version?: string): Promise<McpServerRecord | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM mcp_servers WHERE tenant_id=$1 AND id=$2 AND ($3::text IS NULL OR version=$3) ORDER BY created_at DESC LIMIT 1", [context.tenantId, serverId, version ?? null]);
      return rows[0] ? serverFromRow(rows[0]) : null;
    });
  }

  async listServers(context: RequestContext): Promise<McpServerRecord[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM mcp_servers WHERE tenant_id=$1 ORDER BY created_at DESC", [context.tenantId])).map(serverFromRow));
  }

  async updateServer(context: RequestContext, serverId: string, version: string, patch: Partial<Pick<McpServerRecord, "approvalStatus" | "schemaDigest" | "tools" | "circuitState" | "failureCount" | "probedAt">> & { circuitOpenedUntil?: string | null }): Promise<McpServerRecord> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE mcp_servers SET approval_status=COALESCE($4,approval_status), schema_digest=COALESCE($5,schema_digest),
          tool_schema=COALESCE($6,tool_schema), circuit_state=COALESCE($7,circuit_state), failure_count=COALESCE($8,failure_count),
          circuit_opened_until=CASE WHEN $9::boolean THEN $10::timestamptz ELSE circuit_opened_until END,
          probed_at=COALESCE($11,probed_at)
         WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING *`,
        [context.tenantId, serverId, version, patch.approvalStatus ?? null, patch.schemaDigest ?? null, patch.tools ? JSON.stringify(patch.tools) : null,
          patch.circuitState ?? null, patch.failureCount ?? null, Object.prototype.hasOwnProperty.call(patch, "circuitOpenedUntil"), patch.circuitOpenedUntil ? new Date(patch.circuitOpenedUntil) : null, patch.probedAt ? new Date(patch.probedAt) : null],
      );
      if (!rows[0]) throw new Error("PI_MCP_SERVER_NOT_FOUND");
      return serverFromRow(rows[0]);
    });
  }

  async recordCircuitFailure(context: RequestContext, serverId: string, version: string, threshold: number, openForMs: number): Promise<McpServerRecord> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE mcp_servers
           SET failure_count = failure_count + 1,
               circuit_state = CASE WHEN failure_count + 1 >= $4 THEN 'open' ELSE circuit_state END,
               circuit_opened_until = CASE WHEN failure_count + 1 >= $4 THEN now() + ($5::double precision * interval '1 millisecond') ELSE circuit_opened_until END
         WHERE tenant_id=$1 AND id=$2 AND version=$3
         RETURNING *`,
        [context.tenantId, serverId, version, threshold, openForMs],
      );
      if (!rows[0]) throw new Error("PI_MCP_SERVER_NOT_FOUND");
      return serverFromRow(rows[0]);
    });
  }

  async putBinding(binding: McpToolBinding): Promise<void> {
    await this.scoped(this.systemContext(binding.tenantId, binding.id), async (db) => {
      await db.query(
        `INSERT INTO mcp_tool_bindings
          (id,tenant_id,server_id,server_version,tool_name,exposed_name,input_schema,required_permissions,risk_level,status,server_digest,schema_digest,data_classification,allowed_profiles,scope_type,scope_id,network_policy_ref,created_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())`,
        [binding.id, binding.tenantId, binding.serverId, binding.serverVersion, binding.toolName, binding.exposedName, JSON.stringify(binding.inputSchema), binding.requiredPermissions,
          binding.riskLevel, binding.status, binding.serverDigest, binding.schemaDigest, binding.dataClassification, binding.allowedProfiles, binding.scope.type,
          binding.scope.type === "project" ? binding.scope.projectId : binding.scope.type === "user" ? binding.scope.actorId : null, binding.networkPolicyRef ?? null, binding.createdBy ?? null],
      );
    });
  }

  async getBinding(context: RequestContext, bindingId: string): Promise<McpToolBinding | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM mcp_tool_bindings WHERE tenant_id=$1 AND id=$2", [context.tenantId, bindingId]);
      return rows[0] ? bindingFromRow(rows[0]) : null;
    });
  }

  async getBindingByName(context: RequestContext, exposedName: string): Promise<McpToolBinding | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM mcp_tool_bindings WHERE tenant_id=$1 AND exposed_name=$2 AND status='approved' ORDER BY updated_at DESC LIMIT 1", [context.tenantId, exposedName]);
      return rows[0] ? bindingFromRow(rows[0]) : null;
    });
  }

  async listBindings(context: RequestContext): Promise<McpToolBinding[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM mcp_tool_bindings WHERE tenant_id=$1 ORDER BY updated_at DESC", [context.tenantId])).map(bindingFromRow));
  }

  async updateBinding(context: RequestContext, bindingId: string, patch: Partial<Pick<McpToolBinding, "status">>): Promise<McpToolBinding> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("UPDATE mcp_tool_bindings SET status=COALESCE($3,status),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [context.tenantId, bindingId, patch.status ?? null]);
      if (!rows[0]) throw new Error("PI_MCP_BINDING_NOT_FOUND");
      return bindingFromRow(rows[0]);
    });
  }
}

function uuidRequired(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("PI_MCP_AUDIT_SCOPE_INVALID");
  return value;
}

export class InMemoryMcpAuditStore implements McpAuditStore {
  readonly items: McpCallAudit[] = [];
  async append(audit: McpCallAudit): Promise<void> { this.items.push(clone(audit)); }
}

export class PostgresMcpAuditStore implements McpAuditStore {
  constructor(private readonly database: TransactionalDatabase) {}
  async append(audit: McpCallAudit): Promise<void> {
    await this.database.withTenant(audit.tenantId, async (db) => {
      await db.query(
        `INSERT INTO pi_mcp_call_audits
          (id,tenant_id,actor_id,session_id,run_id,binding_id,server_id,server_version,tool_name,schema_digest,input_digest,output_digest,result_classification,status,error_code,latency_ms,trace_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [audit.id, audit.tenantId, audit.actorId, uuidRequired(audit.sessionId), uuidRequired(audit.runId), audit.bindingId, audit.serverId, audit.serverVersion, audit.toolName,
          audit.schemaDigest, audit.inputDigest, audit.outputDigest ?? null, audit.resultClassification, audit.status, audit.errorCode ?? null, audit.latencyMs ?? null, audit.traceId, new Date(audit.createdAt)],
      );
    });
  }
}

export class PostgresMcpAuditScopeReadinessStore implements McpAuditScopeReadinessPort {
  constructor(private readonly database: TransactionalDatabase) {}

  async check() {
    const rows = await this.database.query<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_constraint WHERE conname=$1 AND conrelid='pi_mcp_call_audits'::regclass",
      ["pi_mcp_call_audits_execution_scope_check"],
    );
    if (!rows[0]) return { ready: false as const, code: "PI_MCP_AUDIT_SCOPE_CONSTRAINT_MISSING" as const };
    if (!rows[0].convalidated) return { ready: false as const, code: "PI_MCP_AUDIT_SCOPE_CONSTRAINT_UNVALIDATED" as const };
    return { ready: true as const };
  }
}
