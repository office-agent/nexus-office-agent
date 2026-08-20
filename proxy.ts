import { NextRequest, NextResponse } from "next/server";
import { consumeLocalAuthRateLimit, getSecurityHeaders } from "@/src/platform/http/security-policy";
import { isLanDeployment } from "@/src/platform/config/runtime-config";
import { incrementCounter } from "@/src/platform/observability/telemetry";

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  if (!requestHeaders.get("x-trace-id")) requestHeaders.set("x-trace-id", crypto.randomUUID());
  incrementCounter("http.requests.total", { method: request.method, routeGroup: routeGroup(request.nextUrl.pathname) });

  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const origin = request.headers.get("origin");
  const webhook = request.nextUrl.pathname.startsWith("/api/v1/integrations/");
  if (unsafeMethod && origin && !webhook && !isAllowedRequestOrigin(request, origin)) {
    incrementCounter("security.csrf_denied.total", { routeGroup: routeGroup(request.nextUrl.pathname) });
    const denied = NextResponse.json({ error: { code: "ORIGIN_DENIED", message: "请求来源校验失败。" } }, { status: 403 });
    for (const [name, value] of Object.entries(getSecurityHeaders())) denied.headers.set(name, value);
    return denied;
  }

  const isAuthEndpoint = request.nextUrl.pathname.startsWith("/api/v1/auth/");
  if (isAuthEndpoint) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const key = `${forwarded || "direct"}:${request.nextUrl.pathname}`;
    const limit = consumeLocalAuthRateLimit(key);
    if (!limit.allowed) {
      const denied = NextResponse.json({ error: { code: "RATE_LIMITED", message: "认证请求过于频繁，请稍后重试。" } }, { status: 429 });
      denied.headers.set("retry-after", String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))));
      denied.headers.set("x-ratelimit-remaining", "0");
      for (const [name, value] of Object.entries(getSecurityHeaders())) denied.headers.set(name, value);
      return denied;
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(getSecurityHeaders())) response.headers.set(name, value);
  if (isAuthEndpoint) response.headers.set("cache-control", "no-store");
  return response;
}

function isAllowedRequestOrigin(request: NextRequest, origin: string): boolean {
  if (isLanDeployment() && isSameLanRequestOrigin(request, origin)) return true;
  const configuredOrigin = normalizeOrigin(process.env.PUBLIC_APP_ORIGIN);
  if (origin === (configuredOrigin ?? request.nextUrl.origin)) return true;

  // A production deployment stays pinned to PUBLIC_APP_ORIGIN. The extra branch
  // only keeps a loopback preview usable when that production origin is present
  // in local .env.local.
  return isSameLoopbackService(request.nextUrl, origin);
}

function isSameLanRequestOrigin(request: NextRequest, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    const requestHost = request.headers.get("host");
    return Boolean(requestHost)
      && originUrl.protocol === request.nextUrl.protocol
      && originUrl.host === requestHost;
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isSameLoopbackService(requestUrl: URL, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === requestUrl.protocol
      && originUrl.port === requestUrl.port
      && isLoopbackHostname(originUrl.hostname)
      && isLoopbackHostname(requestUrl.hostname);
  } catch {
    return false;
  }
}

function routeGroup(pathname: string): string {
  if (pathname.startsWith("/api/v1/auth/")) return "auth";
  if (pathname.startsWith("/api/v1/integrations/")) return "integration";
  if (pathname.startsWith("/api/v1/agent") || pathname === "/api/agent") return "agent";
  if (pathname.startsWith("/api/")) return "api";
  return "web";
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
