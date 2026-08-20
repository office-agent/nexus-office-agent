import { measureOperation } from "@/src/platform/observability/telemetry";

export class ManagedSecretClient {
  constructor(private readonly endpoint = process.env.SECRET_MANAGER_URL, private readonly token = process.env.SECRET_MANAGER_AUTH_TOKEN, private readonly fetcher: typeof fetch = fetch) {
    if (!endpoint || !token) throw new Error("SECRET_MANAGER_UNCONFIGURED");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !["localhost","127.0.0.1"].includes(url.hostname)) throw new Error("SECRET_MANAGER_HTTPS_REQUIRED");
  }

  async resolveString(reference: string, purpose: string): Promise<string> {
    if (!/^secret:\/\/[a-zA-Z0-9/_-]{1,200}$/.test(reference) || reference.includes("..")) throw new Error("SECRET_REFERENCE_INVALID");
    return measureOperation("secret_manager.resolve", { purpose }, async () => {
      const response = await this.fetcher(this.endpoint!, { method:"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({ref:reference,purpose}),cache:"no-store",signal:AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(response.status===404?"SECRET_NOT_FOUND":"SECRET_MANAGER_UNAVAILABLE");
      const body=await response.json() as {value?:unknown};
      if (typeof body.value!=="string" || !body.value) throw new Error("SECRET_VALUE_INVALID");
      return body.value;
    });
  }
}
