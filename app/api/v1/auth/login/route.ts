import { NextResponse } from "next/server";
import { createOidcState, discoverOidc, loadOidcConfiguration, oidcStateCookieHeader, pkceChallenge } from "@/src/platform/identity/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const config = loadOidcConfiguration();
    const discovery = await discoverOidc(config);
    const requestUrl = new URL(request.url);
    const { value, state } = createOidcState(config, requestUrl.searchParams.get("returnTo") ?? undefined);
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "openid");
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", config.redirectUri);
    authorization.searchParams.set("state", state.state);
    authorization.searchParams.set("nonce", state.nonce);
    authorization.searchParams.set("code_challenge", pkceChallenge(state.verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("prompt", "select_account");
    const response = NextResponse.redirect(authorization);
    response.headers.append("set-cookie", oidcStateCookieHeader(value));
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: { code: "SSO_UNAVAILABLE", message: "企业单点登录尚未完成配置或身份提供方暂不可用。" } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
