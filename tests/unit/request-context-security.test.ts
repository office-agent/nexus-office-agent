// Requirements: SR-001, SR-002, SR-004, AC-003
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { DEMO_MANAGER_ID } from "@/src/platform/context/development-context";
import { getSafeRuntimeStatus } from "@/src/platform/config/runtime-config";

afterEach(() => vi.unstubAllEnvs());

describe("production request identity", () => {
  it("fails closed when no verified provider is connected", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "false");
    await expect(resolveRequestContext(new Request("http://localhost"))).rejects.toThrow(AuthenticationRequiredError);
    expect(getSafeRuntimeStatus().identity.mode).toBe("verified-provider-required");
  });

  it("allows the explicit local acceptance identity without trusting browser tenant headers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "true");
    const context = await resolveRequestContext(new Request("http://localhost", { headers: { "x-user-id": "attacker", "x-tenant-id": "attacker" } }));
    expect(context.actorId).toBe(DEMO_MANAGER_ID);
    expect(getSafeRuntimeStatus().identity.mode).toBe("demo");
  });

  it("allows the explicit LAN profile only when its local identity flag is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_DEPLOYMENT_MODE", "lan");
    vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "true");
    await expect(resolveRequestContext(new Request("http://192.168.1.20:3117"))).resolves.toMatchObject({ actorId: DEMO_MANAGER_ID });

    vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "false");
    await expect(resolveRequestContext(new Request("http://192.168.1.20:3117"))).rejects.toThrow(AuthenticationRequiredError);
  });
});
