import type { DomainEvent, UnifiedEvent } from "@/src/modules/events/domain/event-envelope";

export interface EventStore {
  appendOutbox(event: DomainEvent): Promise<void>;
  claimInbound(event: UnifiedEvent): Promise<"accepted" | "duplicate">;
  markInboundProcessed(event: UnifiedEvent): Promise<void>;
  markInboundFailed(event: UnifiedEvent, category: string): Promise<void>;
}

export class InMemoryEventStore implements EventStore {
  readonly outbox: DomainEvent[] = [];
  readonly inbound = new Map<string, { event: UnifiedEvent; status: "received" | "processed" | "failed"; category?: string }>();

  async appendOutbox(event: DomainEvent): Promise<void> {
    if (this.outbox.some((existing) => existing.id === event.id)) return;
    this.outbox.push(event);
  }

  async claimInbound(event: UnifiedEvent): Promise<"accepted" | "duplicate"> {
    const key = `${event.tenantId}:${event.provider}:${event.connectionId}:${event.eventId}`;
    if (this.inbound.has(key)) return "duplicate";
    this.inbound.set(key, { event, status: "received" });
    return "accepted";
  }

  async markInboundProcessed(inboundEvent: UnifiedEvent): Promise<void> {
    const entry = this.inbound.get(`${inboundEvent.tenantId}:${inboundEvent.provider}:${inboundEvent.connectionId}:${inboundEvent.eventId}`);
    if (!entry) throw new Error("INBOUND_EVENT_NOT_FOUND");
    entry.status = "processed";
  }

  async markInboundFailed(inboundEvent: UnifiedEvent, category: string): Promise<void> {
    const entry = this.inbound.get(`${inboundEvent.tenantId}:${inboundEvent.provider}:${inboundEvent.connectionId}:${inboundEvent.eventId}`);
    if (!entry) throw new Error("INBOUND_EVENT_NOT_FOUND");
    entry.status = "failed";
    entry.category = category;
  }
}
