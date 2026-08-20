// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { EgressPolicyCompiler } from "@/src/modules/pi-agent/application/sandbox-policy";
import { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import { InMemoryPiSandboxRunStore } from "@/src/modules/pi-agent/infrastructure/sandbox-run-store";
import { createPiSandboxProvider, VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { HmacPiSandboxRunTokenIssuer } from "@/src/modules/pi-agent/application/sandbox-token";
import { HttpSandboxSupervisorClient, type FetchLike } from "@/src/modules/pi-agent/infrastructure/microvm-sandbox";

const context = (tenantId = "tenant-a", actorId = "actor-a"): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "session-a",
  channel: "system",
  traceId: `trace-${tenantId}`,
  roles: ["pi-runner"],
  permissions: [],
  dataScopes: [{ type: "tenant" }],
});

describe("Pi sandbox control plane", () => {
  it("compiles default-deny egress and rejects SSRF/metadata destinations", () => {
    const compiler = new EgressPolicyCompiler();
    expect(compiler.compile({ mode: "none" })).toMatchObject({ defaultAction: "deny", dnsMode: "deny", metadataBlocked: true, directEgress: false, destinations: [] });
    expect(compiler.compile({ mode: "allowlist", proxyRef: "egress-prod", destinations: [{ host: "api.example.com", ports: [443] }] })).toMatchObject({
      dnsMode: "proxy-only",
      destinations: [{ host: "api.example.com", ports: [443], protocols: ["tcp"] }],
    });
    expect(() => compiler.compile({ mode: "allowlist", proxyRef: "egress-prod", destinations: [{ host: "169.254.169.254", ports: [80] }] })).toThrow("PI_EGRESS_DESTINATION_BLOCKED");
    expect(() => compiler.compile({ mode: "allowlist", proxyRef: "egress-prod", destinations: [{ host: "*.example.com", ports: [443] }] })).toThrow("PI_EGRESS_HOST_INVALID");
    expect(() => compiler.compile({ mode: "allowlist", destinations: [{ host: "api.example.com", ports: [443] }] })).toThrow("PI_EGRESS_PROXY_REQUIRED");
  });

  it("binds every remote Supervisor request to a short-lived Run Token without placing it in the body", async () => {
    const issuer = new HmacPiSandboxRunTokenIssuer("sandbox-run-token-test-secret-0123456789", 60_000);
    const fixedNow = new Date("2026-08-20T12:00:00.000Z");
    const requests: Array<{ headers: Headers; body?: string }> = [];
    const fetcher: FetchLike = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const requestToken = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      issuer.verify(requestToken, requests.length === 0
        ? { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", provider: "firecracker" }
        : { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", provider: "firecracker", sandboxId: "remote-sandbox-a" }, fixedNow);
      requests.push({ headers, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ sandbox: {
        id: "remote-sandbox-a",
        root: "/sandbox/root",
        provider: "firecracker",
        tenantId: "tenant-a",
        actorId: "actor-a",
        sessionId: "session-a",
        runId: "run-a",
      } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new HttpSandboxSupervisorClient("https://sandbox-supervisor.example", { tokenIssuer: issuer, fetcher, now: () => fixedNow });
    const spec = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      sessionId: "session-a",
      workspaceId: "workspace-a",
      profile: "coding" as const,
      networkPolicy: "none" as const,
      runId: "run-a",
    };

    const sandbox = await client.create("firecracker", spec);
    expect(sandbox).toMatchObject({ provider: "firecracker", workspaceId: "workspace-a", runId: "run-a" });
    const authorization = requests[0]?.headers.get("authorization");
    expect(authorization).toMatch(/^Bearer pst\.v1\./);
    const token = authorization!.slice("Bearer ".length);
    expect(issuer.verify(token, { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", provider: "firecracker" }, fixedNow)).toMatchObject({ audience: "pi-sandbox" });
    expect(requests[0]?.body).not.toContain(token);

    await client.setLimits(sandbox, {
      cpuMillis: 2_000,
      memoryBytes: 128 * 1024 * 1024,
      pids: 64,
      diskBytes: 128 * 1024 * 1024,
      maxDurationMs: 60_000,
      maxOutputBytes: 10_000,
    });
    expect(requests).toHaveLength(2);
    const operationToken = requests[1]?.headers.get("authorization")?.slice("Bearer ".length) ?? "";
    expect(requests[1]?.headers.get("authorization")).toMatch(/^Bearer pst\.v1\./);
    expect(issuer.verify(operationToken, { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", provider: "firecracker", sandboxId: "remote-sandbox-a" }, fixedNow)).toMatchObject({ sandboxId: "remote-sandbox-a" });
    expect(() => issuer.verify(token, { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-other", runId: "run-a", provider: "firecracker" }, fixedNow)).toThrow("PI_SANDBOX_RUN_TOKEN_SCOPE_MISMATCH");
    expect(() => issuer.verify(`${token}tampered`, undefined, fixedNow)).toThrow("PI_SANDBOX_RUN_TOKEN_INVALID");
  });

  it("records lifecycle, applies limits/policy before running, and verifies destruction", async () => {
    const runs = new InMemoryPiSandboxRunStore();
    const orchestrator = new SandboxOrchestrator(new VirtualSandboxProvider(), runs);
    const sandbox = await orchestrator.createSandbox(context(), {
      runId: "run-a",
      workspaceId: "workspace-a",
      profile: "coding",
      networkPolicy: "none",
      limits: { memoryBytes: 128 * 1024 * 1024 },
      workspaceMount: { sourceRef: "workspace-snapshot-a", targetPath: "workspace", readOnly: false },
    });

    await orchestrator.write(context(), sandbox, "src/app.ts", "export const answer = 42;");
    expect(await orchestrator.read(context(), sandbox, "src/app.ts")).toMatchObject({ path: "src/app.ts" });
    expect((await orchestrator.collectUsage(context(), sandbox)).diskBytes).toBeGreaterThan(0);
    expect((await orchestrator.getRun(context(), (await runs.list(context(), "session-a"))[0].id)).status).toBe("running");
    await expect(orchestrator.read(context("tenant-b"), sandbox, "src/app.ts")).rejects.toThrow("PI_SANDBOX_TENANT_DENIED");
    await expect(orchestrator.read(context("tenant-a", "actor-b"), sandbox, "src/app.ts")).rejects.toThrow("PI_SANDBOX_ACTOR_DENIED");

    expect(await orchestrator.destroy(context(), sandbox)).toBe(true);
    const record = (await runs.list(context(), "session-a"))[0];
    expect(record).toMatchObject({ status: "destroyed", destroyVerified: true, providerSandboxId: sandbox.id });
    await expect(orchestrator.read(context(), sandbox, "src/app.ts")).rejects.toThrow("PI_SANDBOX_HANDLE_NOT_FOUND");
  });

  it("fails closed for invalid lifecycle transitions", async () => {
    const runs = new InMemoryPiSandboxRunStore();
    const orchestrator = new SandboxOrchestrator(new VirtualSandboxProvider(), runs);
    const sandbox = await orchestrator.createSandbox(context(), { runId: "run-b", workspaceId: "workspace-a", profile: "coding", networkPolicy: "none" });
    await orchestrator.destroy(context(), sandbox);
    const record = (await runs.list(context(), "session-a"))[0];
    expect(record.status).toBe("destroyed");
    await expect(runs.transition(context(), record.id, "running")).rejects.toThrow("PI_SANDBOX_STATE_CONFLICT");
  });

  it("never selects a virtual or unconfigured provider in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_PI_SANDBOX_PROVIDER", "virtual");
    vi.stubEnv("NEXUS_PI_SANDBOX_ENDPOINT", "");
    expect(createPiSandboxProvider().kind).toBe("unavailable");
    vi.unstubAllEnvs();
  });
});
