export type OtlpProbeResult = { ok: boolean; errorCode?: string };

function logsEndpoint(value: string): string {
  const url = new URL(value);
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
  else if (!url.pathname.endsWith("/v1/logs")) url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/logs`;
  return url.toString();
}

function exporterHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("OTLP_HEADERS_INVALID");
    return [decodeURIComponent(entry.slice(0,separator).trim()), decodeURIComponent(entry.slice(separator + 1).trim())];
  }));
}

export async function probeOtlpExporter(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<OtlpProbeResult> {
  const configured = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configured) return { ok: false, errorCode: "OTLP_ENDPOINT_UNCONFIGURED" };
  let endpoint: string;
  let headers: Record<string, string>;
  try {
    endpoint = logsEndpoint(configured);
    headers = exporterHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  } catch {
    return { ok: false, errorCode: "OTLP_CONFIGURATION_INVALID" };
  }
  const controller = new AbortController();
  const timeoutMs = Number(env.OTEL_PROBE_TIMEOUT_MS ?? 3_000);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3_000);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        resourceLogs: [{
          resource: { attributes: [
            { key: "service.name", value: { stringValue: "nexus-office" } },
            { key: "service.version", value: { stringValue: env.NEXUS_RELEASE_VERSION ?? "unknown" } },
          ] },
          scopeLogs: [{ scope: { name: "nexus.readiness" }, logRecords: [{
            timeUnixNano: `${now.getTime()}000000`,
            severityText: "INFO",
            body: { stringValue: "runtime-readiness-probe" },
            attributes: [{ key: "probe", value: { boolValue: true } }],
          }] }],
        }],
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok ? { ok: true } : { ok: false, errorCode: `OTLP_HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, errorCode: error instanceof Error && error.name === "AbortError" ? "OTLP_TIMEOUT" : "OTLP_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}
