import type { AcceptanceConnection, AcceptanceProbeResult, AcceptanceStep, ConnectorAcceptanceProbe, IdentityAcceptanceProbe } from "@/src/modules/integration/application/acceptance";
import type { CollaborationConnector } from "@/src/modules/integration/domain/connector";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import { DingtalkConnector, FeishuConnector, InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { createConnectorSecretResolver, type ConnectorSecretResolver } from "@/src/modules/integration/infrastructure/secret-resolver";
import { AccessTokenBroker, EnvironmentOutgoingCredentialSource, FetchRawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import { discoverOidc, loadOidcConfiguration, type OidcConfiguration } from "@/src/platform/identity/oidc";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

type TokenProvider = Pick<AccessTokenBroker, "get">;
type ConnectorFactory = (connection: AcceptanceConnection) => CollaborationConnector;

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "ACCEPTANCE_PROBE_FAILED";
  return /^[A-Z0-9_:.-]{1,160}$/.test(value) ? value : "ACCEPTANCE_PROBE_FAILED";
}

function blockedConfiguration(code: string): boolean {
  return code.startsWith("CONFIG_REQUIRED:") || code.includes("UNCONFIGURED") || code.endsWith("_NOT_FOUND") || code === "MANAGED_SECRET_PROVIDER_REQUIRED";
}

function step(id: string, status: AcceptanceStep["status"], summary: string, checkedAt: string, code?: string): AcceptanceStep {
  return { id, status, summary, checkedAt, ...(code ? { code } : {}) };
}

export class DefaultConnectorAcceptanceProbe implements ConnectorAcceptanceProbe {
  constructor(
    private readonly callbacks: ConnectorSecretResolver,
    private readonly tokens: TokenProvider,
    private readonly connectors: ConnectorFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(connection: AcceptanceConnection): Promise<AcceptanceProbeResult> {
    const steps: AcceptanceStep[] = [step("connection", "passed", "租户连接存在且状态允许验证。", this.now().toISOString())];
    steps.push(connection.externalOrganizationId
      ? step("organization_binding", "passed", "连接已绑定明确的外部企业标识。", this.now().toISOString())
      : step("organization_binding", "blocked", "连接尚未绑定外部企业，不能将凭据成功等同于租户归属验证。", this.now().toISOString(), "EXTERNAL_ORGANIZATION_BINDING_REQUIRED"));
    try {
      await this.callbacks.resolve(connection.secretRef, connection.provider);
      steps.push(step("callback_secret", "passed", "回调密钥引用可解析且结构有效。", this.now().toISOString()));
    } catch (error) {
      const code = errorCode(error);
      steps.push(step("callback_secret", blockedConfiguration(code) ? "blocked" : "failed", "回调密钥尚未通过安全解析。", this.now().toISOString(), code));
    }

    let tokenReady = false;
    try {
      await this.tokens.get(connection.id, connection.provider, true);
      tokenReady = true;
      steps.push(step("token_exchange", "passed", "应用凭据已成功换取短期访问令牌。", this.now().toISOString()));
    } catch (error) {
      const code = errorCode(error);
      steps.push(step("token_exchange", blockedConfiguration(code) ? "blocked" : "failed", "平台访问令牌交换未通过。", this.now().toISOString(), code));
    }

    let capabilities = connection.capabilities;
    if (!tokenReady) {
      steps.push(step("platform_api", "blocked", "平台 API 验证等待访问令牌。", this.now().toISOString(), "TOKEN_PREREQUISITE_BLOCKED"));
    } else {
      const connector = this.connectors(connection);
      const health = await connector.healthCheck();
      capabilities = [...connector.capabilities];
      steps.push(step(
        "platform_api", health.status === "healthy" ? "passed" : "failed",
        health.status === "healthy" ? "平台身份 API 已使用真实令牌成功响应。" : "平台 API 未返回健康结果。",
        health.checkedAt, health.issues[0],
      ));
    }

    return {
      steps,
      safeEvidence: {
        provider: connection.provider,
        connectionId: connection.id,
        transportMode: connection.transportMode ?? "unspecified",
        externalOrganizationBound: Boolean(connection.externalOrganizationId),
        capabilities,
      },
    };
  }
}

export class DefaultIdentityAcceptanceProbe implements IdentityAcceptanceProbe {
  constructor(
    private readonly loadConfiguration: () => OidcConfiguration = loadOidcConfiguration,
    private readonly discovery: typeof discoverOidc = discoverOidc,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<AcceptanceProbeResult> {
    const steps: AcceptanceStep[] = [];
    let config: OidcConfiguration;
    try {
      config = this.loadConfiguration();
      steps.push(step("oidc_configuration", "passed", "OIDC 客户端、回调、会话密钥和主体映射结构有效。", this.now().toISOString()));
    } catch (error) {
      const code = errorCode(error);
      steps.push(step("oidc_configuration", blockedConfiguration(code) ? "blocked" : "failed", "OIDC 本地配置未通过。", this.now().toISOString(), code));
      steps.push(step("oidc_discovery", "blocked", "OIDC Discovery 等待有效本地配置。", this.now().toISOString(), "OIDC_CONFIGURATION_BLOCKED"));
      steps.push(step("oidc_jwks", "blocked", "JWKS 验证等待 Discovery。", this.now().toISOString(), "OIDC_DISCOVERY_BLOCKED"));
      return { steps, safeEvidence: { configured: false, subjectMappingCount: 0 } };
    }

    let discovered: Awaited<ReturnType<typeof discoverOidc>>;
    try {
      discovered = await this.discovery(config, this.fetcher);
      steps.push(step("oidc_discovery", "passed", "OIDC Discovery 的 issuer 与 HTTPS 端点有效。", this.now().toISOString()));
    } catch (error) {
      const code = errorCode(error);
      steps.push(step("oidc_discovery", "failed", "OIDC Discovery 未通过。", this.now().toISOString(), code));
      steps.push(step("oidc_jwks", "blocked", "JWKS 验证等待 Discovery。", this.now().toISOString(), "OIDC_DISCOVERY_BLOCKED"));
      return { steps, safeEvidence: { configured: true, issuerOrigin: new URL(config.issuer).origin, subjectMappingCount: Object.keys(config.subjectMappings).length } };
    }

    let keyCount = 0;
    try {
      const response = await this.fetcher(discovered.jwks_uri, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OIDC_JWKS_UPSTREAM_${response.status}`);
      const payload = await response.json() as { keys?: unknown[] };
      keyCount = Array.isArray(payload.keys) ? payload.keys.length : 0;
      if (keyCount < 1) throw new Error("OIDC_JWKS_EMPTY");
      steps.push(step("oidc_jwks", "passed", "签名公钥集合可读取且至少包含一个密钥。", this.now().toISOString()));
    } catch (error) {
      steps.push(step("oidc_jwks", "failed", "OIDC 签名公钥集合未通过。", this.now().toISOString(), errorCode(error)));
    }
    return {
      steps,
      safeEvidence: { configured: true, issuerOrigin: new URL(config.issuer).origin, subjectMappingCount: Object.keys(config.subjectMappings).length, jwksKeyCount: keyCount },
    };
  }
}

export function createRuntimeConnectorAcceptanceProbe(): DefaultConnectorAcceptanceProbe {
  const http = new FetchRawHttpClient();
  const tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), http);
  const control = new InMemoryConnectorControlPlane();
  const callbacks: ConnectorSecretResolver = {
    async resolve(secretRef, provider) { return createConnectorSecretResolver().resolve(secretRef, provider); },
  };
  const connectors: ConnectorFactory = (connection) => {
    const transport = new AuthenticatedConnectorTransport(connection.provider, connection.id, tokens, http);
    if (connection.provider === "feishu") return new FeishuConnector(transport, control);
    if (connection.provider === "dingtalk") return new DingtalkConnector(transport, control);
    return new WecomConnector(transport, control, requireWecomAgentId());
  };
  return new DefaultConnectorAcceptanceProbe(callbacks, tokens, connectors);
}

export function createRuntimeIdentityAcceptanceProbe(): DefaultIdentityAcceptanceProbe {
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  return new DefaultIdentityAcceptanceProbe(loadOidcConfiguration, discoverOidc, boundedFetch);
}
