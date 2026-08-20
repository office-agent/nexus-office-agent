import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import type { ChannelActorContextResolver } from "@/src/modules/integration/application/channel-action-handler";
import {
  DingtalkConnector,
  FeishuConnector,
  WecomConnector,
  type ConnectorControlPlane,
  type ConnectorTransport,
} from "@/src/modules/integration/infrastructure/platform-connector";
import type {
  ExternalIdentityInput,
  ExternalOrg,
  ExternalPage,
  ExternalUser,
  IdentityCandidate,
  InstallationInput,
  InstallationStatus,
  TokenInput,
  TokenMetadata,
} from "@/src/modules/integration/domain/connector";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { AuthorizationResolver } from "@/src/platform/identity/authorization-resolver";

export class PostgresIdentityConnectorControlPlane implements ConnectorControlPlane {
  constructor(private readonly database: TransactionalDatabase) {}

  async verifyInstallation(provider: ExternalProvider, input: InstallationInput): Promise<InstallationStatus> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<{ status: string; capabilities: string[] }>(
        "SELECT status,capabilities FROM connections WHERE tenant_id=$1 AND id=$2 AND provider=$3",
        [input.tenantId,input.connectionId,provider],
      );
      if (!rows[0]) return { valid: false, capabilities: [], issues: ["CONNECTION_NOT_FOUND"] };
      return {
        valid: rows[0].status === "active" || rows[0].status === "degraded",
        capabilities: [],
        issues: rows[0].status === "active" || rows[0].status === "degraded" ? [] : [`CONNECTION_${rows[0].status.toUpperCase()}`],
      };
    });
  }

  async token(provider: ExternalProvider, input: TokenInput): Promise<TokenMetadata> {
    void provider;
    void input;
    throw new Error("IDENTITY_CONTROL_PLANE_TOKEN_DISABLED");
  }

  async resolveIdentity(provider: ExternalProvider, input: ExternalIdentityInput): Promise<IdentityCandidate> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<{ status: IdentityCandidate["status"] | "revoked"; internal_subject_type: string; internal_subject_id: string }>(
        `SELECT status,internal_subject_type,internal_subject_id::text
         FROM external_identities
         WHERE tenant_id=$1 AND connection_id=$2 AND provider=$3 AND subject_type=$4 AND external_subject_id=$5`,
        [input.tenantId,input.connectionId,provider,input.subjectType,input.externalSubjectId],
      );
      const row = rows[0];
      if (!row || row.status === "revoked") return { externalSubjectId: input.externalSubjectId, status: "not_found" };
      return {
        externalSubjectId: input.externalSubjectId,
        status: row.status,
        internalSubjectType: row.internal_subject_type as IdentityCandidate["internalSubjectType"],
        internalSubjectId: row.internal_subject_id,
      };
    });
  }

  async organizations(provider: ExternalProvider, cursor?: string): Promise<ExternalPage<ExternalOrg>> {
    void provider;
    void cursor;
    return { items: [] };
  }

  async users(provider: ExternalProvider, cursor?: string): Promise<ExternalPage<ExternalUser>> {
    void provider;
    void cursor;
    return { items: [] };
  }
}

class IdentityOnlyTransport implements ConnectorTransport {
  async request(): Promise<never> { throw new Error("IDENTITY_ONLY_CONNECTOR_TRANSPORT_DISABLED"); }
}

export function createIdentityConnectorRegistry(database: TransactionalDatabase): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  const controlPlane = new PostgresIdentityConnectorControlPlane(database);
  const transport = new IdentityOnlyTransport();
  registry.register(new FeishuConnector(transport, controlPlane));
  registry.register(new DingtalkConnector(transport, controlPlane));
  registry.register(new WecomConnector(transport, controlPlane, ""));
  return registry;
}

export class PostgresChannelActorContextResolver implements ChannelActorContextResolver {
  private readonly identities: PostgresIdentityConnectorControlPlane;
  constructor(database: TransactionalDatabase, private readonly authorization: AuthorizationResolver) {
    this.identities = new PostgresIdentityConnectorControlPlane(database);
  }

  async resolve(input: { tenantId: string; connectionId: string; provider: ExternalProvider; externalUserId: string; traceId: string }) {
    const identity = await this.identities.resolveIdentity(input.provider, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      subjectType: "user",
      externalSubjectId: input.externalUserId,
    });
    if (identity.status !== "verified" || identity.internalSubjectType !== "user" || !identity.internalSubjectId) return null;
    const authorization = await this.authorization.resolve(input.tenantId, identity.internalSubjectId);
    if (!authorization) return null;
    return {
      tenantId: input.tenantId,
      actorId: identity.internalSubjectId,
      sessionId: `${input.provider}:${input.connectionId}:${input.externalUserId}`,
      channel: input.provider,
      traceId: input.traceId,
      ...authorization,
    };
  }
}
