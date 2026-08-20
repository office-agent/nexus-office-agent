// Requirements: SR-001
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const originalPublicAppOrigin = process.env.PUBLIC_APP_ORIGIN;
const originalDeploymentMode = process.env.NEXUS_DEPLOYMENT_MODE;

function unsafeRequest(url: string, origin: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { host: new URL(url).host, origin, "content-type": "application/json" },
  });
}

afterEach(() => {
  if (originalPublicAppOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
  else process.env.PUBLIC_APP_ORIGIN = originalPublicAppOrigin;
  if (originalDeploymentMode === undefined) delete process.env.NEXUS_DEPLOYMENT_MODE;
  else process.env.NEXUS_DEPLOYMENT_MODE = originalDeploymentMode;
});

describe("proxy request-origin validation", () => {
  it("keeps a loopback preview usable when a production public origin is configured", () => {
    process.env.PUBLIC_APP_ORIGIN = "https://office.example.com/";

    const response = proxy(unsafeRequest("http://127.0.0.1:3117/api/v1/agent/runs", "http://127.0.0.1:3117"));

    expect(response.status).toBe(200);
  });

  it("continues to deny a foreign origin", async () => {
    process.env.PUBLIC_APP_ORIGIN = "https://office.example.com";

    const response = proxy(unsafeRequest("http://127.0.0.1:3117/api/v1/agent/runs", "https://untrusted.example"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ORIGIN_DENIED" } });
  });

  it("accepts the exact LAN host origin without requiring a public origin variable", () => {
    process.env.NEXUS_DEPLOYMENT_MODE = "lan";
    delete process.env.PUBLIC_APP_ORIGIN;
    const response = proxy(unsafeRequest("http://192.168.1.20:3117/api/v1/agent/runs", "http://192.168.1.20:3117"));
    expect(response.status).toBe(200);
  });
});
