import { spawn } from "node:child_process";

export async function runTool(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.once("error", () => reject(new Error("OPERATION_TOOL_UNAVAILABLE")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("OPERATION_TOOL_FAILED")));
  });
}

export async function resolveOperationalKey(reference: string, purpose: string): Promise<Buffer> {
  const endpoint = process.env.SECRET_MANAGER_URL;
  const token = process.env.SECRET_MANAGER_AUTH_TOKEN;
  if (!endpoint || !token || process.env.SECRET_PROVIDER !== "managed-http") throw new Error("MANAGED_SECRET_PROVIDER_REQUIRED");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ref: reference, purpose }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("SECRET_MANAGER_UNAVAILABLE");
  const body = await response.json() as { value?: unknown };
  if (typeof body.value !== "string") throw new Error("OPERATIONAL_KEY_INVALID");
  const key = Buffer.from(body.value, "base64");
  if (key.length !== 32) throw new Error("OPERATIONAL_KEY_INVALID");
  return key;
}
