import type { UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { EventStore } from "@/src/modules/events/application/event-store";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { WebhookVerifier, IncomingWebhook } from "@/src/modules/integration/application/webhook-verifier";
import type { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import type { VerifiedRawEvent } from "@/src/modules/integration/domain/connector";

export type AcceptedWebhook = { id: string; provider: ExternalProvider; acceptedAt: string; event: VerifiedRawEvent };

export interface InboundQueue {
  enqueue(item: AcceptedWebhook): Promise<void>;
  dequeue(): Promise<AcceptedWebhook | null>;
}

export class InMemoryInboundQueue implements InboundQueue {
  readonly items: AcceptedWebhook[] = [];
  async enqueue(item: AcceptedWebhook): Promise<void> { this.items.push(structuredClone(item)); }
  async dequeue(): Promise<AcceptedWebhook | null> { return this.items.shift() ?? null; }
}

export type InboundBusinessHandler = (event: UnifiedEvent) => Promise<void>;

export class InboundPipeline {
  private readonly verifiers = new Map<ExternalProvider, WebhookVerifier>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly events: EventStore,
    private readonly queue: InboundQueue,
    private readonly handler: InboundBusinessHandler,
  ) {}

  registerVerifier(verifier: WebhookVerifier): void { this.verifiers.set(verifier.provider, verifier); }

  async accept(request: IncomingWebhook): Promise<{ status: 202; accepted: true }> {
    const verifier = this.verifiers.get(request.provider);
    if (!verifier) throw new Error(`WEBHOOK_VERIFIER_NOT_REGISTERED:${request.provider}`);
    const event = verifier.verify(request);
    await this.queue.enqueue({ id: request.traceId ?? crypto.randomUUID(), provider: request.provider, acceptedAt: new Date().toISOString(), event });
    return { status: 202, accepted: true };
  }

  async processNext(): Promise<{ processed: number; duplicates: number; failures: number } | null> {
    const queued = await this.queue.dequeue();
    if (!queued) return null;
    return this.processVerified(queued.provider, queued.event);
  }

  async processVerified(provider: ExternalProvider, raw: ReturnType<WebhookVerifier["verify"]>): Promise<{ processed: number; duplicates: number; failures: number }> {
    const connector = this.registry.get(provider);
    const normalized = await connector.normalizeInboundEvent(raw);
    let processed = 0; let duplicates = 0; let failures = 0;
    for (const event of normalized) {
      if (await this.events.claimInbound(event) === "duplicate") { duplicates += 1; continue; }
      try {
        if (event.externalActor) {
          const identity = await connector.resolveIdentity({ tenantId: event.tenantId, connectionId: event.connectionId, subjectType: "user", externalSubjectId: event.externalActor.id });
          if (identity.status !== "verified") throw new Error("EXTERNAL_IDENTITY_UNRESOLVED");
        }
        await this.handler(event);
        await this.events.markInboundProcessed(event);
        processed += 1;
      } catch (error) {
        await this.events.markInboundFailed(event, error instanceof Error ? error.message : "INBOUND_PROCESSING_FAILED");
        failures += 1;
      }
    }
    return { processed, duplicates, failures };
  }
}
