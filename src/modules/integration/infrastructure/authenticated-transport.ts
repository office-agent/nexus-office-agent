import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { ConnectorTransport, ConnectorTransportResponse } from "@/src/modules/integration/infrastructure/platform-connector";
import type { AccessTokenBroker, RawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";

const baseUrls: Record<ExternalProvider, string> = {
  feishu: "https://open.feishu.cn",
  dingtalk: "https://api.dingtalk.com",
  wecom: "https://qyapi.weixin.qq.com",
};

export class AuthenticatedConnectorTransport implements ConnectorTransport {
  constructor(private readonly provider: ExternalProvider, private readonly connectionId: string, private readonly tokens: AccessTokenBroker, private readonly http: RawHttpClient) {}

  async request(input: { method: "GET" | "POST" | "PATCH"; path: string; body?: Record<string, unknown>; headers?: Record<string, string> }): Promise<ConnectorTransportResponse> {
    const token = await this.tokens.get(this.connectionId, this.provider);
    let url = `${baseUrls[this.provider]}${input.path}`;
    const headers = { ...input.headers };
    if (this.provider === "feishu") headers.authorization = `Bearer ${token.value}`;
    else if (this.provider === "dingtalk") headers["x-acs-dingtalk-access-token"] = token.value;
    else {
      const parsed = new URL(url);
      parsed.searchParams.set("access_token", token.value);
      url = parsed.toString();
    }
    const response = await this.http.request({ method: input.method, url, headers, body: input.body });
    return { status: response.status, body: response.body, headers: response.headers };
  }
}
