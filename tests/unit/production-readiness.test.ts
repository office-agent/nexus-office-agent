// Requirements: AR-006, AR-009, AR-010, AR-011, AR-012, SR-001, SR-002, SR-003, SR-004, SR-005, AC-008, AC-010
import { describe, expect, it } from "vitest";
import { getProductionReadiness, getSafeRuntimeStatus } from "@/src/platform/config/runtime-config";

function readyEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production", NEXUS_ALLOW_DEMO_IDENTITY: "false",
    PUBLIC_APP_ORIGIN: "https://office.example", OIDC_ISSUER: "https://idp.example", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret", OIDC_REDIRECT_URI: "https://office.example/api/v1/auth/callback", OIDC_SUBJECT_MAP_JSON: JSON.stringify({ "https://idp.example::subject": { tenantId: "tenant", actorId: "actor", roles: ["manager"], permissions: ["project:read"], dataScopes: [{ type: "tenant" }] } }), SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    DATABASE_URL: "postgres://database.example/nexus", AUDIT_RETENTION_DAYS: "365",
    OPENAI_API_KEY: "injected", OPENAI_MODEL: "gpt-enterprise",
    SECRET_PROVIDER: "managed-http", SECRET_MANAGER_URL: "https://vault.example/resolve", SECRET_MANAGER_AUTH_TOKEN: "injected",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example", WAF_MODE: "upstream", RATE_LIMIT_MODE: "upstream",
    NEXUS_RELEASE_VERSION: "0.12.0", REQUIRED_WORKER_ROLES: "inbox,agent,outbox",
    BACKUP_TARGET_URI: "file:///mnt/immutable-backups", BACKUP_ENCRYPTION_KEY_REF: "secret://backup/key",
    ENABLED_CONNECTORS: "feishu", FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "injected",
    CLIENT_MIN_VERSION: "0.9.0", CLIENT_MANAGED_DEVICE_REQUIRED: "true", CLIENT_OFFLINE_DRAFTS: "disabled", CLIENT_PUSH_ENABLED: "false",
  };
}

describe("production readiness gate", () => {
  it("opens an explicit LAN profile without pretending it is production", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      NEXUS_DEPLOYMENT_MODE: "lan",
      NEXUS_ALLOW_DEMO_IDENTITY: "true",
      LAN_STORAGE_MODE: "memory",
      LLM_API_KEY: "local-profile",
      LLM_MODEL: "gpt-5.6",
    };
    const readiness = getProductionReadiness(environment);
    expect(readiness).toMatchObject({ ready: true, mode: "lan" });
    expect(readiness.checks.find(({ id }) => id === "lan.storage")?.status).toBe("warning");
    expect(getSafeRuntimeStatus(environment).identity.mode).toBe("lan");
  });

  it("passes only when every enterprise control is declared", () => {
    const environment = readyEnvironment();
    expect(getProductionReadiness(environment).ready).toBe(true);
    expect(getSafeRuntimeStatus(environment).identity.mode).toBe("oidc");
    expect(JSON.stringify(getSafeRuntimeStatus(environment))).not.toContain("postgres://");
    expect(JSON.stringify(getSafeRuntimeStatus(environment))).not.toContain("injected");
  });

  it("fails closed for demo identity, weak session secret and absent operational controls", () => {
    const environment = readyEnvironment();
    environment.NEXUS_ALLOW_DEMO_IDENTITY = "true"; environment.SESSION_SECRET = "short"; delete environment.WAF_MODE;
    const readiness = getProductionReadiness(environment);
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.filter((item) => item.status === "fail").map((item) => item.id)).toEqual(expect.arrayContaining(["identity.demo-disabled", "identity.session-secret", "operations.waf"]));
  });

  it("does not treat a non-HTTPS telemetry string or undeclared release as production-ready", () => {
    const environment = readyEnvironment();
    environment.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.internal";
    delete environment.NEXUS_RELEASE_VERSION;
    const readiness = getProductionReadiness(environment);
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.filter((item) => item.status === "fail").map(({ id }) => id)).toEqual(
      expect.arrayContaining(["operations.telemetry-config","operations.worker-contract"]),
    );
  });
});
