import { NextResponse } from "next/server";
import { clearOidcStateCookieHeader, exchangeOidcCallback, loadOidcConfiguration, OIDC_STATE_COOKIE_NAME, verifyOidcState } from "@/src/platform/identity/oidc";
import { readCookie, sessionCookieHeader } from "@/src/platform/identity/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const stateCookie = readCookie(request, OIDC_STATE_COOKIE_NAME);
    if (!code || !returnedState || !stateCookie || url.searchParams.has("error")) throw new Error("OIDC_CALLBACK_INVALID");
    const config = loadOidcConfiguration();
    const state = verifyOidcState(stateCookie, returnedState, config);
    const result = await exchangeOidcCallback({ code, state, config });
    const response = NextResponse.redirect(new URL(result.returnTo, request.url));
    response.headers.append("set-cookie", sessionCookieHeader(result.session));
    response.headers.append("set-cookie", clearOidcStateCookieHeader());
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    const response = NextResponse.json({ error: { code: "SSO_CALLBACK_REJECTED", message: "单点登录校验失败或该企业账号尚未完成平台授权。" } }, { status: 401 });
    response.headers.append("set-cookie", clearOidcStateCookieHeader());
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
