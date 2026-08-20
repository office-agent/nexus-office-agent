// Requirements: PR-004, AR-005, AR-009, AR-010, IR-001, IR-004, AC-005, AC-006
import { describe, expect, it } from "vitest";
import { deriveExternalEventId, digestPayload } from "@/src/modules/events/domain/event-envelope";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { FakeConnector } from "@/src/modules/integration/infrastructure/fake-connector";

describe("events and connector contracts", () => {
  it("derives the same id for semantically identical stable fields", () => {
    const left = deriveExternalEventId({
      provider: "feishu",
      connectionId: "connection-1",
      eventType: "message.received",
      occurredAt: "2026-08-05T00:00:00.000Z",
      stableFields: { b: 2, a: 1 },
    });
    const right = deriveExternalEventId({
      provider: "feishu",
      connectionId: "connection-1",
      eventType: "message.received",
      occurredAt: "2026-08-05T00:00:00.000Z",
      stableFields: { a: 1, b: 2 },
    });
    expect(left).toBe(right);
  });

  it("deduplicates an inbound event before business processing", async () => {
    const connector = new FakeConnector("feishu");
    const [event] = await connector.normalizeInboundEvent({
      provider: "feishu",
      connectionId: "connection-1",
      tenantId: "tenant-a",
      transport: "stream",
      receivedAt: "2026-08-05T00:00:00.000Z",
      rawBody: "fixture",
      body: { eventId: "external-1", eventType: "message.received", occurredAt: "2026-08-05T00:00:00.000Z", payload: { text: "hello" } },
      traceId: "trace-1",
    });
    const store = new InMemoryEventStore();
    expect(await store.claimInbound(event)).toBe("accepted");
    expect(await store.claimInbound(event)).toBe("duplicate");
  });

  it("makes message delivery idempotent", async () => {
    const connector = new FakeConnector("dingtalk");
    const command = {
      tenantId: "tenant-a",
      connectionId: "connection-1",
      idempotencyKey: "message-1",
      recipient: { type: "user" as const, externalId: "external-user-1" },
      message: { type: "info" as const, text: "hello" },
    };
    const first = await connector.sendMessage(command);
    const second = await connector.sendMessage(command);
    expect(second.externalMessageId).toBe(first.externalMessageId);
    expect(connector.sent.size).toBe(1);
  });

  it("hashes nested payloads deterministically", () => {
    expect(digestPayload({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      digestPayload({ a: true, z: [{ a: 1, b: 2 }] }),
    );
  });
});
