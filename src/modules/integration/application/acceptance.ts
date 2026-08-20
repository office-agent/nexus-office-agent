import { randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { ConnectorCapability, ConnectionStatus } from "@/src/modules/integration/domain/connector";
import type { RequestContext } from "@/src/platform/context/request-context";

export type AcceptanceStepStatus = "passed" | "failed" | "blocked";
export type AcceptanceRunStatus = AcceptanceStepStatus;

export type AcceptanceStep = {
  id: string;
  status: AcceptanceStepStatus;
  summary: string;
  code?: string;
  checkedAt: string;
};

export type AcceptanceConnection = {
  id: string;
  tenantId: string;
  provider: ExternalProvider;
  name: string;
  status: ConnectionStatus;
  secretRef: string;
  transportMode?: "stream" | "http";
  externalOrganizationId?: string;
  capabilities: ConnectorCapability[];
};

export type AcceptanceRun = {
  id: string;
  tenantId: string;
  runKind: "identity" | "connector";
  subjectId: string;
  provider?: ExternalProvider;
  connectionId?: string;
  status: AcceptanceRunStatus;
  steps: AcceptanceStep[];
  safeEvidence: Record<string, unknown>;
  initiatedBy: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
};

export interface AcceptanceRepository {
  listConnections(tenantId: string): Promise<AcceptanceConnection[]>;
  getConnection(tenantId: string, provider: ExternalProvider, connectionId: string): Promise<AcceptanceConnection | null>;
  latestRuns(tenantId: string): Promise<AcceptanceRun[]>;
  appendRun(run: AcceptanceRun): Promise<void>;
}

export type AcceptanceProbeResult = { steps: AcceptanceStep[]; safeEvidence: Record<string, unknown> };
export interface IdentityAcceptanceProbe { run(): Promise<AcceptanceProbeResult>; }
export interface ConnectorAcceptanceProbe { run(connection: AcceptanceConnection): Promise<AcceptanceProbeResult>; }

function requirePolicy(context: RequestContext, action: "read" | "execute", id: string): void {
  const decision = evaluateAccess({ context, action, resource: { tenantId: context.tenantId, type: "integration_acceptance", id } });
  if (!decision.allowed) throw new Error(`POLICY_DENIED:${decision.reason}`);
}

function runStatus(steps: AcceptanceStep[]): AcceptanceRunStatus {
  if (steps.some(({ status }) => status === "failed")) return "failed";
  if (steps.some(({ status }) => status === "blocked")) return "blocked";
  return "passed";
}

export class IntegrationAcceptanceService {
  constructor(
    private readonly repository: AcceptanceRepository,
    private readonly identityProbe: IdentityAcceptanceProbe,
    private readonly connectorProbe: ConnectorAcceptanceProbe,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(context: RequestContext) {
    requirePolicy(context, "read", "overview");
    const [connections, latestRuns] = await Promise.all([this.repository.listConnections(context.tenantId), this.repository.latestRuns(context.tenantId)]);
    return {
      identity: latestRuns.find(({ runKind, subjectId }) => runKind === "identity" && subjectId === "oidc"),
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        status: connection.status,
        transportMode: connection.transportMode,
        externalOrganizationId: connection.externalOrganizationId,
        capabilities: connection.capabilities,
        latestRun: latestRuns.find(({ runKind, subjectId }) => runKind === "connector" && subjectId === connection.id),
      })),
      generatedAt: this.now().toISOString(),
    };
  }

  async runIdentity(context: RequestContext): Promise<AcceptanceRun> {
    requirePolicy(context, "execute", "identity:oidc");
    return this.execute(context, { runKind: "identity", subjectId: "oidc" }, () => this.identityProbe.run());
  }

  async runConnector(context: RequestContext, provider: ExternalProvider, connectionId: string): Promise<AcceptanceRun> {
    requirePolicy(context, "execute", `connector:${connectionId}`);
    const connection = await this.repository.getConnection(context.tenantId, provider, connectionId);
    if (!connection) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND");
    if (["suspended", "revoked"].includes(connection.status)) throw new Error(`INTEGRATION_CONNECTION_CANNOT_VERIFY:${connection.status}`);
    return this.execute(context, { runKind: "connector", subjectId: connection.id, provider, connectionId }, () => this.connectorProbe.run(connection));
  }

  private async execute(
    context: RequestContext,
    subject: Pick<AcceptanceRun, "runKind" | "subjectId" | "provider" | "connectionId">,
    probe: () => Promise<AcceptanceProbeResult>,
  ): Promise<AcceptanceRun> {
    const startedAt = this.now().toISOString();
    const result = await probe();
    const completedAt = this.now().toISOString();
    const run: AcceptanceRun = {
      id: randomUUID(), tenantId: context.tenantId, ...subject, status: runStatus(result.steps), steps: result.steps,
      safeEvidence: result.safeEvidence, initiatedBy: context.actorId, traceId: context.traceId, startedAt, completedAt,
    };
    await this.repository.appendRun(run);
    return run;
  }
}
