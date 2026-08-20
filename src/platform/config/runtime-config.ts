import { isDataScope } from "@/src/platform/identity/session";
import { loadWecomRuntimeConfiguration } from "@/src/platform/config/wecom-environment";

export type RuntimeCapability = {
  configured: boolean;
  source: "environment" | "dedicated-environment" | "managed-secret" | "default" | "unconfigured";
};

export type SafeRuntimeStatus = {
  identity: { mode: "demo" | "lan" | "oidc" | "verified-provider-required" };
  database: RuntimeCapability;
  model: RuntimeCapability;
  secretManagement: RuntimeCapability & { mode: "managed-http" | "environment" | "unconfigured" };
  observability: RuntimeCapability;
  edgeProtection: { waf: boolean; rateLimit: boolean };
  backup: RuntimeCapability;
  connectors: {
    feishu: RuntimeCapability;
    dingtalk: RuntimeCapability;
    wecom: RuntimeCapability;
  };
};

export type ReadinessCheck = {
  id: string;
  category: "identity" | "data" | "ai" | "secrets" | "operations" | "integration";
  status: "pass" | "fail" | "warning";
  message: string;
};

export type ProductionReadiness = {
  ready: boolean;
  mode: "development" | "lan" | "production";
  checks: ReadinessCheck[];
};

export function isLanDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXUS_DEPLOYMENT_MODE === "lan";
}

function environmentCapability(keys: string[], env: NodeJS.ProcessEnv = process.env): RuntimeCapability {
  const configured = keys.every((key) => Boolean(env[key]));
  return { configured, source: configured ? "environment" : "unconfigured" };
}

function check(id: string, category: ReadinessCheck["category"], passed: boolean, message: string): ReadinessCheck {
  return { id, category, status: passed ? "pass" : "fail", message };
}

function enabledConnectors(env: NodeJS.ProcessEnv): string[] {
  return (env.ENABLED_CONNECTORS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function validHttpsUrl(value: string | undefined): boolean {
  try { return Boolean(value && new URL(value).protocol === "https:"); } catch { return false; }
}

function validSubjectMap(value: string | undefined): boolean {
  try {
    const parsed = JSON.parse(value ?? "") as Record<string, unknown>;
    const entries = Object.entries(parsed);
    return entries.length > 0 && entries.every(([key, mapping]) => {
      if (!key.includes("::") || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) return false;
      const record = mapping as Record<string, unknown>;
      return typeof record.tenantId === "string" && Boolean(record.tenantId)
        && typeof record.actorId === "string" && Boolean(record.actorId)
        && Array.isArray(record.roles) && record.roles.every((item) => typeof item === "string")
        && Array.isArray(record.permissions) && record.permissions.every((item) => typeof item === "string")
        && Array.isArray(record.dataScopes) && record.dataScopes.every(isDataScope);
    });
  } catch { return false; }
}

function validPostgresUrl(value: string | undefined): boolean {
  try { return Boolean(value && ["postgres:", "postgresql:"].includes(new URL(value).protocol)); } catch { return false; }
}

export function getProductionReadiness(env: NodeJS.ProcessEnv = process.env): ProductionReadiness {
  const production = env.NODE_ENV === "production";
  const lan = isLanDeployment(env);
  const oidcKeys = ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"];
  const sessionSecretValid = Buffer.byteLength(env.SESSION_SECRET ?? "", "utf8") >= 32;
  const connectors = enabledConnectors(env);
  const connectorKeys: Record<string, string[]> = {
    feishu: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    dingtalk: ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"],
    wecom: ["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_APP_SECRET"],
  };
  const wecom = loadWecomRuntimeConfiguration(env);
  const knownConnectors = connectors.length > 0 && new Set(connectors).size === connectors.length && connectors.every((provider) => provider in connectorKeys);
  const connectorCredentials = knownConnectors && connectors.every((provider) => provider === "wecom"
    ? wecom.configured
    : connectorKeys[provider].every((key) => Boolean(env[key])));
  const retentionDays = Number(env.AUDIT_RETENTION_DAYS ?? 0);
  const identityOriginsValid = validHttpsUrl(env.PUBLIC_APP_ORIGIN) && validHttpsUrl(env.OIDC_ISSUER) && validHttpsUrl(env.OIDC_REDIRECT_URI)
    && new URL(env.OIDC_REDIRECT_URI!).origin === new URL(env.PUBLIC_APP_ORIGIN!).origin;
  const backupConfigured = (() => {
    try { return new URL(env.BACKUP_TARGET_URI ?? "").protocol === "file:" && /^secret:\/\//.test(env.BACKUP_ENCRYPTION_KEY_REF ?? ""); } catch { return false; }
  })();
  const clientPolicyConfigured = Boolean(env.CLIENT_MIN_VERSION)
    && ["true", "false"].includes(env.CLIENT_MANAGED_DEVICE_REQUIRED ?? "")
    && ["disabled", "internal"].includes(env.CLIENT_OFFLINE_DRAFTS ?? "")
    && ["true", "false"].includes(env.CLIENT_PUSH_ENABLED ?? "")
    && (env.CLIENT_PUSH_ENABLED !== "true" || Boolean(env.CLIENT_PUSH_PUBLIC_KEY && /^secret:\/\//.test(env.CLIENT_DATA_ENCRYPTION_KEY_REF ?? "")));
  const requiredWorkerRoles = (env.REQUIRED_WORKER_ROLES ?? "inbox,agent,outbox").split(",").map((value) => value.trim()).filter(Boolean);
  const workerRolesValid = requiredWorkerRoles.length > 0 && new Set(requiredWorkerRoles).size === requiredWorkerRoles.length
    && requiredWorkerRoles.every((role) => ["inbox","agent","outbox","pi-runner","pi-change-delivery"].includes(role));
  const releaseVersionValid = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(env.NEXUS_RELEASE_VERSION ?? "");
  const piChangeDeliveryConfigured = !requiredWorkerRoles.includes("pi-change-delivery") || (() => {
    try {
      const forgejoHttps = Boolean(env.NEXUS_PI_FORGEJO_API_URL && new URL(env.NEXUS_PI_FORGEJO_API_URL).protocol === "https:");
      const managedSecret = env.SECRET_PROVIDER === "managed-http" && Boolean(env.SECRET_MANAGER_AUTH_TOKEN && env.SECRET_MANAGER_URL && new URL(env.SECRET_MANAGER_URL).protocol === "https:");
      const openbaoSecret = (env.SECRET_PROVIDER === "openbao" || Boolean(env.OPENBAO_ADDR)) && Boolean(env.OPENBAO_ADDR && new URL(env.OPENBAO_ADDR).protocol === "https:");
      return env.NEXUS_PI_CHANGE_DELIVERY_EXTERNAL_ENABLED === "true" && forgejoHttps && (managedSecret || openbaoSecret);
    } catch { return false; }
  })();

  const checks: ReadinessCheck[] = [
    check("identity.demo-disabled", "identity", env.NEXUS_ALLOW_DEMO_IDENTITY !== "true", "生产环境必须关闭演示身份。"),
    check("identity.oidc", "identity", oidcKeys.every((key) => Boolean(env[key])) && validSubjectMap(env.OIDC_SUBJECT_MAP_JSON), "OIDC 客户端和至少一个显式主体映射均有效。"),
    check("identity.origins", "identity", identityOriginsValid, "应用、OIDC issuer 与回调均为 HTTPS，且回调属于应用源。"),
    check("identity.session-secret", "identity", sessionSecretValid, "会话签名密钥至少 32 字节。"),
    check("data.postgres", "data", validPostgresUrl(env.DATABASE_URL), "PostgreSQL 持久化连接已配置。"),
    check("data.audit-retention", "data", Number.isFinite(retentionDays) && retentionDays >= 180, "审计保留期不少于 180 天。"),
    check("ai.model", "ai", env.NEXUS_MODEL_MODE !== "disabled" && Boolean((env.OPENAI_API_KEY || env.LLM_API_KEY) && (env.OPENAI_MODEL || env.LLM_MODEL)), "模型凭据和明确模型版本已配置，且未触发运维熔断。"),
    check("secrets.manager", "secrets", env.SECRET_PROVIDER === "managed-http" && validHttpsUrl(env.SECRET_MANAGER_URL) && Boolean(env.SECRET_MANAGER_AUTH_TOKEN), "连接器密钥由 HTTPS 受管密钥服务按引用解析。"),
    check("operations.telemetry-config", "operations", validHttpsUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT), "OTLP HTTPS 导出端点已声明；真实发送由运行探测验证。"),
    check("operations.worker-contract", "operations", workerRolesValid && releaseVersionValid, "必需 Worker 角色和发布版本已显式声明。"),
    check("operations.pi-change-delivery", "operations", piChangeDeliveryConfigured, "启用 Change Delivery Worker 时，Forgejo Gateway、HTTPS 和受管 Secret 已显式配置。"),
    check("operations.waf", "operations", env.WAF_MODE === "upstream", "入口 WAF 由受管网关提供。"),
    check("operations.rate-limit", "operations", env.RATE_LIMIT_MODE === "upstream", "分布式限流由受管网关提供。"),
    check("operations.backup", "operations", backupConfigured, "版本化挂载备份目标和 secret:// 加密密钥引用已配置。"),
    check("operations.client-policy", "operations", clientPolicyConfigured, "最低客户端版本、设备/离线/推送策略及推送加密已显式配置。"),
    check("integration.enabled", "integration", knownConnectors, "至少选择一个且仅选择受支持的协作平台。"),
    check("integration.credentials", "integration", connectorCredentials, "已启用平台的应用凭据均已注入。"),
  ];
  if (lan) {
    const modelConfigured = env.NEXUS_MODEL_MODE !== "disabled"
      && Boolean((env.OPENAI_API_KEY || env.LLM_API_KEY) && (env.OPENAI_MODEL || env.LLM_MODEL));
    const origin = env.PUBLIC_APP_ORIGIN?.trim();
    const originValid = !origin || (() => {
      try { return ["http:", "https:"].includes(new URL(origin).protocol); } catch { return false; }
    })();
    const storageMode = env.LAN_STORAGE_MODE ?? "memory";
    const storageConfigured = storageMode === "memory" || (storageMode === "postgres" && validPostgresUrl(env.DATABASE_URL));
    const lanChecks: ReadinessCheck[] = [
      check("lan.identity", "identity", env.NEXUS_ALLOW_DEMO_IDENTITY === "true", "局域网模式使用显式本地身份；不接入外部 OIDC。"),
      check("lan.model", "ai", modelConfigured, "局域网 Agent 模型凭据和模型版本已配置。"),
      { id: "lan.origin", category: "identity", status: origin ? (originValid ? "pass" : "fail") : "warning", message: origin ? "局域网访问源已声明。" : "未声明 PUBLIC_APP_ORIGIN，将按实际请求源校验；建议配置局域网访问地址。" },
      { id: "lan.storage", category: "data", status: storageConfigured ? (storageMode === "memory" ? "warning" : "pass") : "fail", message: storageMode === "memory" ? "使用进程内存储；重启后业务事实会清空，建议切换 LAN_STORAGE_MODE=postgres。" : "使用局域网 PostgreSQL 持久化。" },
      { id: "lan.external-controls", category: "operations", status: "warning", message: "局域网模式不要求 OIDC、受管 Secret、WAF、OTLP、外部备份和企业微信连接器；该模式不得暴露到互联网。" },
    ];
    return { ready: lanChecks.every((item) => item.status !== "fail"), mode: "lan", checks: lanChecks };
  }
  if (!production) {
    checks.unshift({ id: "environment.development", category: "operations", status: "warning", message: "当前为开发模式；生产门禁仅作预检。" });
  }
  return { ready: production && checks.every((item) => item.status !== "fail"), mode: production ? "production" : "development", checks };
}

export function getSafeRuntimeStatus(env: NodeJS.ProcessEnv = process.env): SafeRuntimeStatus {
  const oidcConfigured = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_SUBJECT_MAP_JSON", "SESSION_SECRET"].every((key) => Boolean(env[key]));
  const secretManaged = env.SECRET_PROVIDER === "managed-http" && Boolean(env.SECRET_MANAGER_URL && env.SECRET_MANAGER_AUTH_TOKEN);
  const wecom = loadWecomRuntimeConfiguration(env);
  return {
    identity: { mode: isLanDeployment(env) ? "lan" : env.NEXUS_ALLOW_DEMO_IDENTITY === "true" ? "demo" : oidcConfigured ? "oidc" : "verified-provider-required" },
    database: environmentCapability(["DATABASE_URL"], env),
    model: {
      configured: Boolean(env.OPENAI_API_KEY || env.LLM_API_KEY),
      source: env.OPENAI_API_KEY || env.LLM_API_KEY ? "environment" : "unconfigured",
    },
    secretManagement: { configured: secretManaged, source: secretManaged ? "managed-secret" : "unconfigured", mode: secretManaged ? "managed-http" : env.SECRET_PROVIDER === "environment" ? "environment" : "unconfigured" },
    observability: environmentCapability(["OTEL_EXPORTER_OTLP_ENDPOINT"], env),
    edgeProtection: { waf: env.WAF_MODE === "upstream", rateLimit: env.RATE_LIMIT_MODE === "upstream" },
    backup: environmentCapability(["BACKUP_TARGET_URI", "BACKUP_ENCRYPTION_KEY_REF"], env),
    connectors: {
      feishu: environmentCapability(["FEISHU_APP_ID", "FEISHU_APP_SECRET"], env),
      dingtalk: environmentCapability(["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"], env),
      wecom: { configured: wecom.configured, source: wecom.source },
    },
  };
}
