import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import { loadWecomRuntimeConfiguration } from "@/src/platform/config/wecom-environment";
import { measureOperation } from "@/src/platform/observability/telemetry";

export type FeishuCallbackSecret = { verificationToken: string; encryptKey: string };
export type EnterpriseCallbackSecret = { token: string; encodingAesKey: string; receiveId: string };
export type ConnectorCallbackSecret = FeishuCallbackSecret | EnterpriseCallbackSecret;

export interface ConnectorSecretResolver {
  resolve(secretRef: string, provider: ExternalProvider): Promise<ConnectorCallbackSecret>;
}

function validateSecret(value: unknown, provider: ExternalProvider): ConnectorCallbackSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONNECTOR_SECRET_INVALID");
  const record = value as Record<string, unknown>;
  if (provider === "feishu") {
    if (typeof record.verificationToken !== "string" || typeof record.encryptKey !== "string") throw new Error("CONNECTOR_SECRET_INVALID");
    return { verificationToken: record.verificationToken, encryptKey: record.encryptKey };
  }
  if (typeof record.token !== "string" || typeof record.encodingAesKey !== "string" || typeof record.receiveId !== "string") throw new Error("CONNECTOR_SECRET_INVALID");
  return { token: record.token, encodingAesKey: record.encodingAesKey, receiveId: record.receiveId };
}

export class EnvironmentConnectorSecretResolver implements ConnectorSecretResolver {
  constructor(private readonly serializedBundle = process.env.CONNECTOR_SECRETS_JSON) {}

  async resolve(secretRef: string, provider: ExternalProvider): Promise<ConnectorCallbackSecret> {
    if (!this.serializedBundle) return this.resolveSingleInstallation(provider);
    let parsed: unknown;
    try { parsed = JSON.parse(this.serializedBundle); } catch { throw new Error("CONNECTOR_SECRET_STORE_INVALID"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CONNECTOR_SECRET_STORE_INVALID");
    const entry = (parsed as Record<string, unknown>)[secretRef];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("CONNECTOR_SECRET_NOT_FOUND");
    return validateSecret(entry, provider);
  }

  private resolveSingleInstallation(provider: ExternalProvider): ConnectorCallbackSecret {
    if (provider === "feishu") {
      const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN; const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
      if (!verificationToken || !encryptKey) throw new Error("CONNECTOR_SECRET_STORE_UNCONFIGURED");
      return { verificationToken, encryptKey };
    }
    if (provider === "dingtalk") {
      const token = process.env.DINGTALK_CALLBACK_TOKEN; const encodingAesKey = process.env.DINGTALK_ENCODING_AES_KEY; const receiveId = process.env.DINGTALK_RECEIVE_ID;
      if (!token || !encodingAesKey || !receiveId) throw new Error("CONNECTOR_SECRET_STORE_UNCONFIGURED");
      return { token, encodingAesKey, receiveId };
    }
    const token = process.env.WECOM_CALLBACK_TOKEN; const encodingAesKey = process.env.WECOM_ENCODING_AES_KEY; const receiveId = loadWecomRuntimeConfiguration().corpId;
    if (!token || !encodingAesKey || !receiveId) throw new Error("CONNECTOR_SECRET_STORE_UNCONFIGURED");
    return { token, encodingAesKey, receiveId };
  }
}

type CachedSecret = { value: ConnectorCallbackSecret; expiresAt: number };

export class ManagedHttpConnectorSecretResolver implements ConnectorSecretResolver {
  private readonly cache = new Map<string, CachedSecret>();

  constructor(
    private readonly endpoint = process.env.SECRET_MANAGER_URL,
    private readonly authorizationToken = process.env.SECRET_MANAGER_AUTH_TOKEN,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cacheTtlMs = 60_000,
  ) {
    if (!endpoint || !authorizationToken) throw new Error("SECRET_MANAGER_UNCONFIGURED");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("SECRET_MANAGER_HTTPS_REQUIRED");
  }

  async resolve(secretRef: string, provider: ExternalProvider): Promise<ConnectorCallbackSecret> {
    if (!/^secret:\/\/[a-zA-Z0-9/_-]{1,200}$/.test(secretRef) || secretRef.includes("..")) throw new Error("CONNECTOR_SECRET_REF_INVALID");
    const cacheKey = `${provider}:${secretRef}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await measureOperation("secret_manager.resolve", { provider }, async () => {
      const response = await this.fetcher(this.endpoint!, {
        method: "POST",
        headers: { authorization: `Bearer ${this.authorizationToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ref: secretRef, purpose: `connector-callback:${provider}` }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(response.status === 404 ? "CONNECTOR_SECRET_NOT_FOUND" : "SECRET_MANAGER_UNAVAILABLE");
      const body = await response.json() as { value?: unknown };
      return validateSecret(body.value, provider);
    });
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }
}

export function createConnectorSecretResolver(): ConnectorSecretResolver {
  if (process.env.NODE_ENV === "production" && process.env.SECRET_PROVIDER !== "managed-http") throw new Error("MANAGED_SECRET_PROVIDER_REQUIRED");
  return process.env.SECRET_PROVIDER === "managed-http" ? new ManagedHttpConnectorSecretResolver() : new EnvironmentConnectorSecretResolver();
}
