// Requirements: PR-004, AR-003, SR-001, SR-004, IR-001, IR-004, AC-001, AC-005, AC-006
import { describe, expect, it } from "vitest";
import { GET as overview } from "@/app/api/v1/integrations/acceptance/route";
import { POST as identity } from "@/app/api/v1/integrations/acceptance/identity/route";
import { POST as connector } from "@/app/api/v1/integrations/acceptance/connectors/[provider]/[connectionId]/route";
import { POST as prepareNotification } from "@/app/api/v1/integrations/test-notifications/route";
import { POST as confirmNotification } from "@/app/api/v1/integrations/test-notifications/[id]/confirm/route";
import { DEMO_CONNECTION_IDS } from "@/src/modules/integration/infrastructure/acceptance-repository";

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("integration acceptance API", () => {
  it("returns blocked rather than pass when real identity and platform credentials are absent", async () => {
    const identityResponse = await identity(post("/api/v1/integrations/acceptance/identity", {}));
    const connectorResponse = await connector(post(`/api/v1/integrations/acceptance/connectors/feishu/${DEMO_CONNECTION_IDS.feishu}`, {}), { params: Promise.resolve({ provider: "feishu", connectionId: DEMO_CONNECTION_IDS.feishu }) });
    expect(identityResponse.status).toBe(200);
    expect(connectorResponse.status).toBe(200);
    const identityPayload = await identityResponse.json();
    expect(identityPayload).toMatchObject({ data: { runKind: "identity", status: "blocked" } });
    expect(identityPayload.data.steps[0]).toMatchObject({ id: "oidc_configuration", status: "blocked" });
    await expect(connectorResponse.json()).resolves.toMatchObject({ data: { runKind: "connector", provider: "feishu", status: "blocked" } });

    const overviewResponse = await overview(new Request("http://localhost/api/v1/integrations/acceptance"));
    const payload = await overviewResponse.json();
    expect(overviewResponse.status).toBe(200);
    expect(payload.data.identity.status).toBe("blocked");
    expect(payload.data.connections.find((item: { provider: string }) => item.provider === "feishu").latestRun.status).toBe("blocked");
    expect(JSON.stringify(payload)).not.toContain("secret://");
  });

  it("rejects unknown self-asserted fields and invalid connection paths", async () => {
    const unknown = await identity(post("/api/v1/integrations/acceptance/identity", { configured: true }));
    const invalid = await connector(post("/api/v1/integrations/acceptance/connectors/feishu/not-a-uuid", {}), { params: Promise.resolve({ provider: "feishu", connectionId: "not-a-uuid" }) });
    expect(unknown.status).toBe(422);
    expect(invalid.status).toBe(422);
  });

  it("keeps outbound acceptance writes closed until a live connection has passed", async () => {
    const blocked = await prepareNotification(post("/api/v1/integrations/test-notifications", {
      provider: "feishu",
      connectionId: DEMO_CONNECTION_IDS.feishu,
      recipientType: "user",
      externalRecipientId: "ou-fixture",
    }));
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: "INTEGRATION_CONNECTION_NOT_ACTIVE" } });

    const invalidPrepare = await prepareNotification(post("/api/v1/integrations/test-notifications", {
      provider: "feishu",
      connectionId: DEMO_CONNECTION_IDS.feishu,
      recipientType: "user",
      externalRecipientId: "ou-fixture",
      skipConfirmation: true,
    }));
    expect(invalidPrepare.status).toBe(422);

    const invalidConfirm = await confirmNotification(post("/api/v1/integrations/test-notifications/not-a-uuid/confirm", {
      proposalHash: "a".repeat(64), externalRecipientId: "ou-fixture",
    }), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(invalidConfirm.status).toBe(422);
  });
});
