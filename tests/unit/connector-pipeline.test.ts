// Requirements: PR-004, IR-002, IR-003, IR-004, SR-001, SR-003, SR-006, AC-001, AC-005
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryInboundQueue, InboundPipeline } from "@/src/modules/integration/application/inbound-pipeline";
import { verifiedStreamEvent } from "@/src/modules/integration/application/webhook-verifier";
import { FeishuConnector, InMemoryConnectorControlPlane, type ConnectorTransport } from "@/src/modules/integration/infrastructure/platform-connector";

const rawMessage = verifiedStreamEvent({ tenantId: "tenant-a", connectionId: "connection-f", provider: "feishu", rawBody: "fixture-message", body: { header: { event_id: "event-message-1", event_type: "im.message.receive_v1", create_time: "1785888000000" }, event: { sender: { sender_id: { open_id: "ou-1" } }, message: { message_id: "message-1", chat_id: "chat-1" } } }, traceId: "trace-message-1" });

describe("connector inbound pipeline", () => {
  it("resolves external identity before processing and deduplicates delivery", async () => {
    const control = new InMemoryConnectorControlPlane();
    control.identities.set("feishu:connection-f:user:ou-1", { externalSubjectId: "ou-1", status: "verified", internalSubjectType: "user", internalSubjectId: "user-a" });
    const connector = new FeishuConnector({ async request() { return { status: 200, body: { code: 0, message_id: "message" } }; } } satisfies ConnectorTransport, control);
    const registry = new ConnectorRegistry(); registry.register(connector);
    const events = new InMemoryEventStore();
    const handled: string[] = [];
    const pipeline = new InboundPipeline(registry, events, new InMemoryInboundQueue(), async (event) => { handled.push(event.eventId); });
    expect(await pipeline.processVerified("feishu", rawMessage)).toEqual({ processed: 1, duplicates: 0, failures: 0 });
    expect(await pipeline.processVerified("feishu", rawMessage)).toEqual({ processed: 0, duplicates: 1, failures: 0 });
    expect(handled).toEqual(["event-message-1"]);
  });

  it("fails closed when an external actor has no verified identity", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new FeishuConnector({ async request() { return { status: 200, body: {} }; } }, new InMemoryConnectorControlPlane()));
    const events = new InMemoryEventStore();
    const pipeline = new InboundPipeline(registry, events, new InMemoryInboundQueue(), async () => { throw new Error("SHOULD_NOT_RUN"); });
    expect(await pipeline.processVerified("feishu", rawMessage)).toEqual({ processed: 0, duplicates: 0, failures: 1 });
    expect([...events.inbound.values()][0]).toMatchObject({ status: "failed", category: "EXTERNAL_IDENTITY_UNRESOLVED" });
  });

  it("re-authenticates a channel confirmation against the mapped internal actor", async () => {
    const control = new InMemoryConnectorControlPlane();
    control.identities.set("feishu:connection-f:user:ou-1", { externalSubjectId: "ou-1", status: "verified", internalSubjectType: "user", internalSubjectId: "user-a" });
    const registry = new ConnectorRegistry();
    registry.register(new FeishuConnector({ async request() { return { status: 200, body: {} }; } }, control));
    const calls: unknown[][] = [];
    const agent = { async confirmProposal(...args: unknown[]) { calls.push(args); return {}; } } as unknown as AgentOrchestrator;
    const handler = new AgentChannelActionHandler(registry, { async resolve(input) { return { tenantId: input.tenantId, actorId: "user-a", sessionId: `feishu:${input.externalUserId}`, channel: "feishu", traceId: input.traceId, roles: ["manager"], permissions: ["risk:create"], dataScopes: [{ type: "project", projectIds: ["project-a"] }] }; } }, agent);
    await handler.handle({ eventId: "card-1", provider: "feishu", connectionId: "connection-f", tenantId: "tenant-a", eventType: "card.action", occurredAt: new Date().toISOString(), externalActor: { type: "user", id: "ou-1" }, payload: { actionId: "agent.confirm:proposal-1", proposalHash: "hash-1", expiresAt: "2099-01-01T00:00:00.000Z" }, rawDigest: "a".repeat(64), schemaVersion: 1, traceId: "trace-card-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("proposal-1");
    expect(calls[0][2]).toBe("hash-1");
  });
});
