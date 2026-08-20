import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { AcceptanceConnection, AcceptanceRepository, AcceptanceRun, AcceptanceStep } from "@/src/modules/integration/application/acceptance";
import type { ConnectorCapability, ConnectionStatus } from "@/src/modules/integration/domain/connector";
import { DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

export const DEMO_CONNECTION_IDS: Record<ExternalProvider, string> = {
  feishu: "21000000-0000-4000-8000-000000000001",
  dingtalk: "21000000-0000-4000-8000-000000000002",
  wecom: "21000000-0000-4000-8000-000000000003",
};

function asJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

type ConnectionRow = {
  id: string; tenant_id: string; provider: ExternalProvider; name: string; status: ConnectionStatus; secret_ref: string;
  transport_mode: "stream" | "http" | null; external_organization_id: string | null; capabilities: unknown;
};
type RunRow = {
  id: string; tenant_id: string; run_kind: "identity" | "connector"; subject_id: string; provider: ExternalProvider | null;
  connection_id: string | null; status: AcceptanceRun["status"]; step_results: unknown; safe_evidence: unknown; initiated_by: string;
  trace_id: string; started_at: string | Date; completed_at: string | Date;
};

const mapConnection = (row: ConnectionRow): AcceptanceConnection => ({
  id: String(row.id), tenantId: String(row.tenant_id), provider: row.provider, name: row.name, status: row.status,
  secretRef: row.secret_ref, transportMode: row.transport_mode ?? undefined, externalOrganizationId: row.external_organization_id ?? undefined,
  capabilities: asJson<ConnectorCapability[]>(row.capabilities, []),
});

const mapRun = (row: RunRow): AcceptanceRun => ({
  id: String(row.id), tenantId: String(row.tenant_id), runKind: row.run_kind, subjectId: row.subject_id,
  provider: row.provider ?? undefined, connectionId: row.connection_id ? String(row.connection_id) : undefined, status: row.status,
  steps: asJson<AcceptanceStep[]>(row.step_results, []), safeEvidence: asJson<Record<string, unknown>>(row.safe_evidence, {}),
  initiatedBy: String(row.initiated_by), traceId: row.trace_id, startedAt: new Date(row.started_at).toISOString(), completedAt: new Date(row.completed_at).toISOString(),
});

export class PostgresAcceptanceRepository implements AcceptanceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async listConnections(tenantId: string): Promise<AcceptanceConnection[]> {
    return this.database.withTenant(tenantId, async (executor) => (await executor.query<ConnectionRow>(
      `SELECT id::text,tenant_id::text,provider,name,status,secret_ref,transport_mode,external_organization_id,capabilities
       FROM connections WHERE tenant_id=$1 AND status<>'revoked' ORDER BY provider,name`, [tenantId],
    )).map(mapConnection));
  }

  async getConnection(tenantId: string, provider: ExternalProvider, connectionId: string): Promise<AcceptanceConnection | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<ConnectionRow>(
        `SELECT id::text,tenant_id::text,provider,name,status,secret_ref,transport_mode,external_organization_id,capabilities
         FROM connections WHERE tenant_id=$1 AND provider=$2 AND id=$3`, [tenantId, provider, connectionId],
      );
      return row ? mapConnection(row) : null;
    });
  }

  async latestRuns(tenantId: string): Promise<AcceptanceRun[]> {
    return this.database.withTenant(tenantId, async (executor) => (await executor.query<RunRow>(
      `SELECT DISTINCT ON (run_kind,subject_id) id::text,tenant_id::text,run_kind,subject_id,provider,connection_id::text,status,
              step_results,safe_evidence,initiated_by::text,trace_id,started_at,completed_at
       FROM enterprise_acceptance_runs WHERE tenant_id=$1 ORDER BY run_kind,subject_id,completed_at DESC`, [tenantId],
    )).map(mapRun));
  }

  async appendRun(run: AcceptanceRun): Promise<void> {
    await this.database.withTenant(run.tenantId, async (executor) => {
      await executor.query(
        `INSERT INTO enterprise_acceptance_runs(id,tenant_id,run_kind,subject_id,provider,connection_id,status,step_results,safe_evidence,initiated_by,trace_id,started_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [run.id,run.tenantId,run.runKind,run.subjectId,run.provider??null,run.connectionId??null,run.status,run.steps,run.safeEvidence,run.initiatedBy,run.traceId,run.startedAt,run.completedAt],
      );
    });
  }
}

function demoConnections(): AcceptanceConnection[] {
  return (["feishu", "dingtalk", "wecom"] as const).map((provider) => ({
    id: DEMO_CONNECTION_IDS[provider], tenantId: DEMO_TENANT_ID, provider, name: `${provider}-acceptance`, status: "draft",
    secretRef: `secret://acceptance/${provider}`, transportMode: provider === "wecom" ? "http" : "stream", capabilities: [],
  }));
}

export class InMemoryAcceptanceRepository implements AcceptanceRepository {
  readonly connections = new Map(demoConnections().map((item) => [item.id, item]));
  readonly runs: AcceptanceRun[] = [];

  async listConnections(tenantId: string) { return [...this.connections.values()].filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)); }
  async getConnection(tenantId: string, provider: ExternalProvider, connectionId: string) {
    const item = this.connections.get(connectionId);
    return item?.tenantId === tenantId && item.provider === provider ? structuredClone(item) : null;
  }
  async latestRuns(tenantId: string) {
    const latest = new Map<string, AcceptanceRun>();
    for (const run of this.runs.filter((item) => item.tenantId === tenantId).sort((a,b) => b.completedAt.localeCompare(a.completedAt))) {
      const key = `${run.runKind}:${run.subjectId}`;
      if (!latest.has(key)) latest.set(key, run);
    }
    return [...latest.values()].map((item) => structuredClone(item));
  }
  async appendRun(run: AcceptanceRun) { this.runs.push(structuredClone(run)); }
}

const runtime = globalThis as typeof globalThis & { __nexusAcceptanceRepository?: InMemoryAcceptanceRepository; __nexusAcceptanceRepositoryVersion?: number };
export function getDevelopmentAcceptanceRepository() {
  if (runtime.__nexusAcceptanceRepositoryVersion !== 1) {
    runtime.__nexusAcceptanceRepository = new InMemoryAcceptanceRepository();
    runtime.__nexusAcceptanceRepositoryVersion = 1;
  }
  return runtime.__nexusAcceptanceRepository!;
}
