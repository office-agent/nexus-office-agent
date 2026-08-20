import { readFile } from "node:fs/promises";

type OpenBaoSecretClientOptions = {
  endpoint?: string;
  tokenProvider?: () => Promise<string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function normalizeEndpoint(value: string | undefined): string {
  if (!value) throw new Error("OPENBAO_UNCONFIGURED");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OPENBAO_ENDPOINT_INVALID"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("OPENBAO_ENDPOINT_INVALID");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("OPENBAO_HTTPS_REQUIRED");
  return url.toString().replace(/\/$/, "");
}

function normalizeReference(reference: string): string {
  if (!/^secret:\/\/[a-zA-Z0-9/_-]{1,200}$/.test(reference) || reference.includes("..")) throw new Error("SECRET_REFERENCE_INVALID");
  const path = reference.slice("secret://".length);
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("//")) throw new Error("SECRET_REFERENCE_INVALID");
  return path;
}

async function fileTokenProvider(): Promise<string> {
  const tokenFile = process.env.OPENBAO_TOKEN_FILE;
  if (!tokenFile) throw new Error("OPENBAO_TOKEN_UNCONFIGURED");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("OPENBAO_TOKEN_INVALID");
  return token;
}

function extractSecretValue(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("OPENBAO_RESPONSE_INVALID");
  const outer = body as Record<string, unknown>;
  const outerData = outer.data;
  if (!outerData || typeof outerData !== "object" || Array.isArray(outerData)) throw new Error("OPENBAO_RESPONSE_INVALID");
  const first = outerData as Record<string, unknown>;
  const data = first.data && typeof first.data === "object" && !Array.isArray(first.data) ? first.data as Record<string, unknown> : first;
  if (typeof data.value === "string" && data.value) return data.value;
  if (Object.keys(data).length > 0) return JSON.stringify(data);
  throw new Error("OPENBAO_SECRET_EMPTY");
}

export class OpenBaoSecretClient {
  private readonly endpoint: string;
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenBaoSecretClientOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint ?? process.env.OPENBAO_ADDR);
    this.tokenProvider = options.tokenProvider ?? fileTokenProvider;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw new Error("OPENBAO_TIMEOUT_INVALID");
  }

  async resolveString(reference: string, purpose: string): Promise<string> {
    const path = normalizeReference(reference);
    const token = await this.tokenProvider();
    if (!token) throw new Error("OPENBAO_TOKEN_INVALID");
    const response = await this.fetcher(`${this.endpoint}/v1/${path}`, {
      method: "GET",
      headers: { accept: "application/json", "x-vault-token": token, "x-nexus-purpose": purpose.slice(0, 128) },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(response.status === 404 ? "OPENBAO_SECRET_NOT_FOUND" : "OPENBAO_UNAVAILABLE");
    return extractSecretValue(await response.json());
  }
}
