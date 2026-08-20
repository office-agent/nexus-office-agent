import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { CollaborationConnector } from "@/src/modules/integration/domain/connector";

export class ConnectorRegistry {
  private readonly connectors = new Map<ExternalProvider, CollaborationConnector>();

  register(connector: CollaborationConnector): void {
    if (this.connectors.has(connector.provider)) throw new Error(`CONNECTOR_ALREADY_REGISTERED:${connector.provider}`);
    this.connectors.set(connector.provider, connector);
  }

  get(provider: ExternalProvider): CollaborationConnector {
    const connector = this.connectors.get(provider);
    if (!connector) throw new Error(`CONNECTOR_NOT_REGISTERED:${provider}`);
    return connector;
  }

  list(): CollaborationConnector[] { return [...this.connectors.values()]; }
}
