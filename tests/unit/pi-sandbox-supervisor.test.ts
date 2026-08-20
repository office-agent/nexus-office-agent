// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile as readText, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PiCompiledEgressPolicy,
  PiSandbox,
  PiSandboxFile,
  PiSandboxLimits,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
} from "@/src/modules/pi-agent/domain/contracts";
import { HmacPiSandboxRunTokenIssuer } from "@/src/modules/pi-agent/application/sandbox-token";
import { createPiSandboxSupervisorServer } from "@/src/modules/pi-agent/supervisor/http-server";
import type { PiSandboxSupervisorBackend } from "@/src/modules/pi-agent/supervisor/contracts";
import { FilePiSandboxBindingStore, InMemoryPiSandboxBindingStore } from "@/src/modules/pi-agent/supervisor/store";
import { collectPiSandboxPreflight } from "@/src/modules/pi-agent/supervisor/preflight";

const now = new Date("2026-08-20T12:00:00.000Z");
const secret = "pi-sandbox-supervisor-test-secret-0123456789";

class FakeSupervisorBackend implements PiSandboxSupervisorBackend {
  readonly kind = "firecracker" as const;
  readonly sandboxes = new Map<string, PiSandbox>();
  limits?: PiSandboxLimits;

  async readiness(): Promise<{ ready: true } | { ready: false; code: string }> { return { ready: true }; }

  async create(spec: PiSandboxSpec): Promise<PiSandbox> {
    const sandbox: PiSandbox = {
      id: "sandbox-a",
      root: "/var/lib/nexus/sandboxes/sandbox-a",
      provider: "firecracker",
      tenantId: spec.tenantId,
      actorId: spec.actorId,
      sessionId: spec.sessionId,
      workspaceId: spec.workspaceId,
      runId: spec.runId,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async mountWorkspace(): Promise<void> {}
  async setLimits(_sandbox: PiSandbox, limits: PiSandboxLimits): Promise<void> { this.limits = limits; }
  async applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy): Promise<void> { void sandbox; void policy; }
  async read(sandbox: PiSandbox, path: string): Promise<PiSandboxFile> { void sandbox; return { path, content: "ok", digest: "digest" }; }
  async list(): Promise<string[]> { return ["src"]; }
  async write(sandbox: PiSandbox, path: string, content: string): Promise<PiSandboxFile> { return { path, content, digest: "digest" }; }
  async applyPatch(sandbox: PiSandbox, path: string, _oldText: string, newText: string): Promise<PiSandboxFile> { return { path, content: newText, digest: "digest" }; }
  async run(): Promise<PiSandboxResult> { return { ok: true, output: "ok", exitCode: 0 }; }
  async snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return { files: [], diff: "", digest: "digest" }; }
  async collectUsage(): Promise<PiSandboxUsage> { return { cpuMillis: 1, memoryBytesPeak: 1, pidsPeak: 1, diskBytes: 1, outputBytes: 1, collectedAt: now.toISOString() }; }
  async terminate(): Promise<void> {}
  async destroy(sandbox: PiSandbox): Promise<void> { this.sandboxes.delete(sandbox.id); }
  async verifyDestroyed(sandbox: PiSandbox): Promise<boolean> { return !this.sandboxes.has(sandbox.id); }
}

async function startServer(options: Parameters<typeof createPiSandboxSupervisorServer>[0]) {
  const server = createPiSandboxSupervisorServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createPiSandboxSupervisorServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function createSpec(): PiSandboxSpec {
  return {
    tenantId: "tenant-a",
    actorId: "actor-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    profile: "coding",
    networkPolicy: "none",
    runId: "run-a",
  };
}

function scopeFor(spec: PiSandboxSpec, sandboxId?: string) {
  return {
    tenantId: spec.tenantId,
    actorId: spec.actorId,
    sessionId: spec.sessionId,
    workspaceId: spec.workspaceId,
    runId: spec.runId!,
    provider: "firecracker" as const,
    ...(sandboxId ? { sandboxId } : {}),
  };
}

class UnreadySupervisorBackend extends FakeSupervisorBackend {
  async readiness(): Promise<{ ready: false; code: string }> {
    return { ready: false, code: "PI_SANDBOX_SUPERVISOR_BACKEND_UNAVAILABLE" };
  }
}

describe("Pi sandbox supervisor", () => {
  const servers: Array<ReturnType<typeof createPiSandboxSupervisorServer>> = [];

  afterEach(async () => {
    while (servers.length) await closeServer(servers.pop()!);
  });

  it("enforces create Run scope, per-operation sandbox scope, and binding cleanup", async () => {
    const issuer = new HmacPiSandboxRunTokenIssuer(secret, 60_000);
    const backend = new FakeSupervisorBackend();
    const { server, baseUrl } = await startServer({ backend, tokenVerifier: issuer, bindingStore: new InMemoryPiSandboxBindingStore(), now: () => now });
    servers.push(server);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);

    const spec = createSpec();
    const createToken = issuer.issue(scopeFor(spec), now);
    const createResponse = await fetch(`${baseUrl}/v1/sandboxes/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${createToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "firecracker", spec }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sandbox: PiSandbox };
    expect(created.sandbox).toMatchObject({ id: "sandbox-a", workspaceId: "workspace-a", provider: "firecracker" });

    const operationToken = issuer.issue(scopeFor(spec, "sandbox-a"), now);
    const limitsResponse = await fetch(`${baseUrl}/v1/sandboxes/sandbox-a/limits`, {
      method: "POST",
      headers: { authorization: `Bearer ${operationToken}`, "content-type": "application/json" },
      body: JSON.stringify({ cpuMillis: 2_000, memoryBytes: 128 * 1024 * 1024, pids: 64, diskBytes: 128 * 1024 * 1024, maxDurationMs: 60_000, maxOutputBytes: 10_000 }),
    });
    expect(limitsResponse.status).toBe(204);
    expect(backend.limits?.pids).toBe(64);

    const wrongTenantToken = issuer.issue({ ...scopeFor(spec, "sandbox-a"), tenantId: "tenant-b" }, now);
    const denied = await fetch(`${baseUrl}/v1/sandboxes/sandbox-a/status`, { headers: { authorization: `Bearer ${wrongTenantToken}` } });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(wrongTenantToken);

    const credentialInBody = await fetch(`${baseUrl}/v1/sandboxes/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${createToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "firecracker", spec, token: createToken }),
    });
    expect(credentialInBody.status).toBe(400);

    const destroyResponse = await fetch(`${baseUrl}/v1/sandboxes/sandbox-a/destroy`, {
      method: "POST",
      headers: { authorization: `Bearer ${operationToken}` },
    });
    expect(destroyResponse.status).toBe(200);
    expect((await destroyResponse.json()).destroyed).toBe(true);
    expect((await fetch(`${baseUrl}/v1/sandboxes/sandbox-a/status`, { headers: { authorization: `Bearer ${operationToken}` } })).status).toBe(404);
  });

  it("persists only the non-secret Sandbox binding and reloads it after a process boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-sandbox-supervisor-test-"));
    try {
      const first = new FilePiSandboxBindingStore(directory);
      await first.put({
        sandbox: { id: "sandbox-persisted", root: "/var/lib/nexus/sandbox-persisted", provider: "firecracker", tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a" },
        scope: { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", provider: "firecracker" },
        createdAt: now.toISOString(),
      });
      const raw = await readText(path.join(directory, "sandbox-persisted.json"), "utf8");
      expect(raw).not.toContain(secret);
      const second = new FilePiSandboxBindingStore(directory);
      await expect(second.get("sandbox-persisted")).resolves.toMatchObject({ sandbox: { id: "sandbox-persisted" }, scope: { runId: "run-a" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps readiness failed closed when the secret or backend is unavailable", async () => {
    const { server, baseUrl } = await startServer({
      backend: new UnreadySupervisorBackend(),
    });
    servers.push(server);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready" });
  });
});

describe("Pi sandbox preflight", () => {
  it("returns ready only when every required Linux microVM prerequisite is present", async () => {
    const result = await collectPiSandboxPreflight({
      NEXUS_PI_SANDBOX_PROVIDER: "firecracker",
      NEXUS_PI_SANDBOX_ROOTFS: "/rootfs.ext4",
      NEXUS_PI_SANDBOX_KERNEL_IMAGE: "/vmlinux",
      NEXUS_PI_SANDBOX_ENDPOINT: "https://sandbox.internal",
      NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET: secret,
    }, {
      platform: "linux",
      arch: "x64",
      access: async () => undefined,
      readFile: async () => "cpu memory pids",
      resolveExecutable: async () => "/usr/bin/firecracker",
      isFile: async () => true,
    });
    expect(result.status).toBe("ready");
    expect(result.checks.every((item) => !item.required || item.status === "pass")).toBe(true);
  });

  it("reports missing KVM without substituting a container result", async () => {
    const result = await collectPiSandboxPreflight({
      NEXUS_PI_SANDBOX_PROVIDER: "firecracker",
      NEXUS_PI_SANDBOX_ROOTFS: "/rootfs.ext4",
      NEXUS_PI_SANDBOX_KERNEL_IMAGE: "/vmlinux",
      NEXUS_PI_SANDBOX_ENDPOINT: "https://sandbox.internal",
      NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET: secret,
    }, {
      platform: "linux",
      arch: "x64",
      access: async (file) => { if (file === "/dev/kvm") throw new Error("missing"); },
      readFile: async () => "cpu memory pids",
      resolveExecutable: async () => "/usr/bin/firecracker",
      isFile: async () => true,
    });
    expect(result.status).toBe("not_ready");
    expect(result.checks.find((item) => item.id === "kvm-device")).toMatchObject({ status: "fail", required: true });
  });
});
