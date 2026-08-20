// Requirements: MR-042, MR-043, MR-044, SR-001, IR-002, AC-011, DR-005
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { ManagementChannelActionHandler } from "@/src/modules/management-intelligence/application/channel-action-handler";
import type { ManagementIntelligenceService } from "@/src/modules/management-intelligence/application/service";

function event() {
  return {
    eventId: "wecom-card-1", provider: "wecom" as const, connectionId: "connection-w", tenantId: "tenant-a", eventType: "card.action" as const,
    occurredAt: "2026-08-05T00:00:00.000Z", externalActor: { type: "user" as const, id: "wx-user-1" },
    payload: { actionId: "management.confirm:action-1", proposalHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" },
    rawDigest: "b".repeat(64), schemaVersion: 1 as const, traceId: "trace-wecom-card-1",
  };
}

describe("management WeCom channel action", () => {
  it("re-resolves the WeCom recipient and authoritative permissions before confirmation", async () => {
    const control = new InMemoryConnectorControlPlane();
    control.identities.set("wecom:connection-w:user:wx-user-1", { externalSubjectId: "wx-user-1", status: "verified", internalSubjectType: "user", internalSubjectId: "internal-user-1" });
    const registry = new ConnectorRegistry();
    registry.register(new WecomConnector({ async request() { return { status: 200, body: {} }; } }, control, "agent-1"));
    const confirmChannelAction = vi.fn(async () => ({}));
    const management = { confirmChannelAction } as unknown as ManagementIntelligenceService;
    const handler = new ManagementChannelActionHandler(registry, { async resolve(input) { return { tenantId: input.tenantId, actorId: "internal-user-1", sessionId: "wecom:verified", channel: "wecom", traceId: input.traceId, roles: ["manager"], permissions: ["enterprise_case:update"], dataScopes: [{ type: "tenant" }] }; } }, management);
    await handler.handle(event());
    expect(confirmChannelAction).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", actorId: "internal-user-1", channel: "wecom" }),
      "action-1",
      "a".repeat(64),
      createHash("sha256").update("wx-user-1").digest("hex"),
    );
  });

  it("fails closed when the mapped actor and current channel context disagree", async () => {
    const control = new InMemoryConnectorControlPlane();
    control.identities.set("wecom:connection-w:user:wx-user-1", { externalSubjectId: "wx-user-1", status: "verified", internalSubjectType: "user", internalSubjectId: "internal-user-1" });
    const registry = new ConnectorRegistry();
    registry.register(new WecomConnector({ async request() { return { status: 200, body: {} }; } }, control, "agent-1"));
    const management = { confirmChannelAction: vi.fn() } as unknown as ManagementIntelligenceService;
    const handler = new ManagementChannelActionHandler(registry, { async resolve(input) { return { tenantId: input.tenantId, actorId: "different-user", sessionId: "wecom:stale", channel: "wecom", traceId: input.traceId, roles: ["manager"], permissions: ["enterprise_case:update"], dataScopes: [{ type: "tenant" }] }; } }, management);
    await expect(handler.handle(event())).rejects.toThrow("CHANNEL_CONTEXT_DENIED");
  });
});
