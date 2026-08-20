import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import { requireWecomCredential } from "@/src/platform/config/wecom-environment";

export type OutgoingCredential =
  | { provider: "feishu"; appId: string; appSecret: string }
  | { provider: "dingtalk"; clientId: string; clientSecret: string }
  | { provider: "wecom"; corpId: string; appSecret: string; agentId: string };

export interface OutgoingCredentialSource {
  resolve(connectionId: string, provider: ExternalProvider): Promise<OutgoingCredential>;
}

export class EnvironmentOutgoingCredentialSource implements OutgoingCredentialSource {
  async resolve(_connectionId: string, provider: ExternalProvider): Promise<OutgoingCredential> {
    if (provider === "feishu") {
      const appId = process.env.FEISHU_APP_ID; const appSecret = process.env.FEISHU_APP_SECRET;
      if (!appId || !appSecret) throw new Error("FEISHU_CREDENTIAL_UNCONFIGURED");
      return { provider, appId, appSecret };
    }
    if (provider === "dingtalk") {
      const clientId = process.env.DINGTALK_CLIENT_ID; const clientSecret = process.env.DINGTALK_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("DINGTALK_CREDENTIAL_UNCONFIGURED");
      return { provider, clientId, clientSecret };
    }
    const { corpId, appSecret, agentId } = requireWecomCredential();
    return { provider, corpId, appSecret, agentId };
  }
}

export type RawHttpResponse = { status: number; body: Record<string, unknown>; headers: Record<string, string> };
export interface RawHttpClient {
  request(input: { method: "GET" | "POST" | "PATCH"; url: string; headers?: Record<string, string>; body?: Record<string, unknown> }): Promise<RawHttpResponse>;
}

export class FetchRawHttpClient implements RawHttpClient {
  constructor(private readonly timeoutMs = 10_000) {}
  async request(input: { method: "GET" | "POST" | "PATCH"; url: string; headers?: Record<string, string>; body?: Record<string, unknown> }): Promise<RawHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(input.url, { method: input.method, headers: { accept: "application/json", ...(input.body ? { "content-type": "application/json" } : {}), ...input.headers }, body: input.body ? JSON.stringify(input.body) : undefined, signal: controller.signal, cache: "no-store" });
      let body: Record<string, unknown> = {};
      try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { body = {}; }
      return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("CONNECTOR_HTTP_TIMEOUT");
      throw new Error("CONNECTOR_HTTP_UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }
}

type CachedToken = { value: string; expiresAt: number };

export class AccessTokenBroker {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<CachedToken>>();
  constructor(private readonly credentials: OutgoingCredentialSource, private readonly http: RawHttpClient, private readonly now: () => number = () => Date.now()) {}

  async get(connectionId: string, provider: ExternalProvider, forceRefresh = false): Promise<{ value: string; expiresAt: string }> {
    const key = `${provider}:${connectionId}`;
    const existing = this.tokens.get(key);
    if (!forceRefresh && existing && existing.expiresAt - 60_000 > this.now()) return { value: existing.value, expiresAt: new Date(existing.expiresAt).toISOString() };
    const inFlight = this.pending.get(key);
    if (inFlight) { const token = await inFlight; return { value: token.value, expiresAt: new Date(token.expiresAt).toISOString() }; }
    const request = this.refresh(connectionId, provider);
    this.pending.set(key, request);
    try {
      const token = await request;
      this.tokens.set(key, token);
      return { value: token.value, expiresAt: new Date(token.expiresAt).toISOString() };
    } finally { this.pending.delete(key); }
  }

  private async refresh(connectionId: string, provider: ExternalProvider): Promise<CachedToken> {
    const credential = await this.credentials.resolve(connectionId, provider);
    let response: RawHttpResponse;
    let token = ""; let expiresIn = 0;
    if (credential.provider === "feishu") {
      response = await this.http.request({ method: "POST", url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", body: { app_id: credential.appId, app_secret: credential.appSecret } });
      token = String(response.body.tenant_access_token ?? ""); expiresIn = Number(response.body.expire ?? 0);
    } else if (credential.provider === "dingtalk") {
      response = await this.http.request({ method: "POST", url: "https://api.dingtalk.com/v1.0/oauth2/accessToken", body: { appKey: credential.clientId, appSecret: credential.clientSecret } });
      token = String(response.body.accessToken ?? ""); expiresIn = Number(response.body.expireIn ?? 0);
    } else {
      const query = new URLSearchParams({ corpid: credential.corpId, corpsecret: credential.appSecret });
      response = await this.http.request({ method: "GET", url: `https://qyapi.weixin.qq.com/cgi-bin/gettoken?${query}` });
      token = String(response.body.access_token ?? ""); expiresIn = Number(response.body.expires_in ?? 0);
    }
    if (response.status < 200 || response.status >= 300 || !token || expiresIn <= 0) throw new Error("CONNECTOR_TOKEN_EXCHANGE_FAILED");
    return { value: token, expiresAt: this.now() + expiresIn * 1000 };
  }
}
