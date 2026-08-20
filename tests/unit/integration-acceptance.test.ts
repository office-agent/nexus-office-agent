// Requirements: PR-004, PR-008, AR-002, AR-003, AR-010, SR-004, IR-001, IR-004, AC-001, AC-005, AC-006
import { describe, expect, it } from "vitest";
import { IntegrationAcceptanceService, type AcceptanceProbeResult } from "@/src/modules/integration/application/acceptance";
import { DefaultConnectorAcceptanceProbe, DefaultIdentityAcceptanceProbe } from "@/src/modules/integration/infrastructure/acceptance-probes";
import { DEMO_CONNECTION_IDS, InMemoryAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { FakeConnector } from "@/src/modules/integration/infrastructure/fake-connector";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";
import type { OidcConfiguration } from "@/src/platform/identity/oidc";

const NOW = new Date("2026-08-05T00:00:00.000Z");
const passed: AcceptanceProbeResult = { steps: [{ id: "fixture", status: "passed", summary: "通过", checkedAt: NOW.toISOString() }], safeEvidence: { fixture: true } };

describe("enterprise integration acceptance", () => {
  it("persists append-only identity and connector evidence and exposes only the latest run", async () => {
    const repository = new InMemoryAcceptanceRepository();
    const service = new IntegrationAcceptanceService(repository, { async run() { return passed; } }, { async run() { return passed; } }, () => NOW);
    const context = createDevelopmentRequestContext("acceptance-service");

    const identity = await service.runIdentity(context);
    const connector = await service.runConnector(context, "feishu", DEMO_CONNECTION_IDS.feishu);
    const overview = await service.overview(context);

    expect(identity).toMatchObject({ runKind: "identity", subjectId: "oidc", status: "passed", traceId: "acceptance-service" });
    expect(connector).toMatchObject({ runKind: "connector", provider: "feishu", connectionId: DEMO_CONNECTION_IDS.feishu, status: "passed" });
    expect(repository.runs).toHaveLength(2);
    expect(overview.identity?.id).toBe(identity.id);
    expect(overview.connections.find(({ provider }) => provider === "feishu")?.latestRun?.id).toBe(connector.id);
    expect(JSON.stringify(overview)).not.toContain("secret://");
  });

  it("distinguishes blocked configuration from failed platform behavior", async () => {
    const repository = new InMemoryAcceptanceRepository();
    const connector = repository.connections.get(DEMO_CONNECTION_IDS.feishu)!;
    const blockedProbe = new DefaultConnectorAcceptanceProbe(
      { async resolve() { throw new Error("CONNECTOR_SECRET_STORE_UNCONFIGURED"); } },
      { async get() { throw new Error("FEISHU_CREDENTIAL_UNCONFIGURED"); } },
      () => new FakeConnector("feishu"),
      () => NOW,
    );
    const blocked = await blockedProbe.run(connector);
    expect(blocked.steps.map(({ id, status }) => [id, status])).toEqual([
      ["connection", "passed"], ["organization_binding", "blocked"], ["callback_secret", "blocked"], ["token_exchange", "blocked"], ["platform_api", "blocked"],
    ]);

    const failedProbe = new DefaultConnectorAcceptanceProbe(
      { async resolve() { return { verificationToken: "fixture", encryptKey: "fixture" }; } },
      { async get() { throw new Error("CONNECTOR_TOKEN_EXCHANGE_FAILED"); } },
      () => new FakeConnector("feishu"),
      () => NOW,
    );
    expect((await failedProbe.run(connector)).steps.find(({ id }) => id === "token_exchange")).toMatchObject({ status: "failed", code: "CONNECTOR_TOKEN_EXCHANGE_FAILED" });
  });

  it("checks OIDC discovery and JWKS without exposing client or session secrets", async () => {
    const config: OidcConfiguration = {
      issuer: "https://idp.example.test", clientId: "fixture-client", clientSecret: "never-output-client-secret",
      redirectUri: "https://office.example.test/api/v1/auth/callback", sessionSecret: "never-output-session-secret-1234567890", stateSecret: "never-output-state-secret-1234567890",
      subjectMappings: { "https://idp.example.test::subject-1": { tenantId: "tenant-a", actorId: "actor-a", roles: ["manager"], permissions: ["project:read"], dataScopes: [{ type: "tenant" }] } },
    };
    const probe = new DefaultIdentityAcceptanceProbe(
      () => config,
      async () => ({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, jwks_uri: `${config.issuer}/jwks` }),
      async () => Response.json({ keys: [{ kid: "key-1", kty: "RSA" }] }),
      () => NOW,
    );
    const result = await probe.run();
    expect(result.steps.every(({ status }) => status === "passed")).toBe(true);
    expect(result.safeEvidence).toEqual({ configured: true, issuerOrigin: "https://idp.example.test", subjectMappingCount: 1, jwksKeyCount: 1 });
    expect(JSON.stringify(result)).not.toContain("never-output");
  });

  it("requires explicit integration acceptance permissions", async () => {
    const service = new IntegrationAcceptanceService(new InMemoryAcceptanceRepository(), { async run() { return passed; } }, { async run() { return passed; } });
    const context = { ...createDevelopmentRequestContext(), permissions: ["project:read"] };
    await expect(service.overview(context)).rejects.toThrow("POLICY_DENIED:PERMISSION_MISSING");
    await expect(service.runIdentity(context)).rejects.toThrow("POLICY_DENIED:PERMISSION_MISSING");
  });
});
