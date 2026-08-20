import { incrementCounter, logOperationalEvent } from "@/src/platform/observability/telemetry";

export async function register() {
  logOperationalEvent("info", "service.instrumentation.registered", { runtime: process.env.NEXT_RUNTIME ?? "nodejs" });
}

export const onRequestError = async (
  error: { digest?: string } & Error,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string; renderSource: string },
) => {
  incrementCounter("http.request_errors.total", { method: request.method, route: context.routePath || "unknown", router: context.routerKind });
  logOperationalEvent("error", "http.request.failed", { method: request.method, path: request.path, route: context.routePath, errorType: error.name, digest: error.digest });
};
