// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PiCompiledEgressPolicy,
  PiSandboxFile,
  PiSandboxLimits,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";
import type { FirecrackerApiRequest, FirecrackerApiResponse, FirecrackerApiTransport } from "@/src/modules/pi-agent/supervisor/firecracker-api";
import { FirecrackerSandboxBackend } from "@/src/modules/pi-agent/supervisor/firecracker-backend";
import type { PiSandboxCgroup, PiSandboxCgroupController } from "@/src/modules/pi-agent/supervisor/cgroup";
import type { PiSandboxGuestAgent, PiSandboxGuestAgentFactory } from "@/src/modules/pi-agent/supervisor/guest-agent";

const limits: PiSandboxLimits = {
  cpuMillis: 2_000,
  memoryBytes: 128 * 1024 * 1024,
  pids: 64,
  diskBytes: 128 * 1024 * 1024,
  maxDurationMs: 60_000,
  maxOutputBytes: 10_000,
};

class FakeProcess {
  readonly pid = 4242;
  alive = true;
  signals: string[] = [];

  async isAlive(): Promise<boolean> { return this.alive; }
  kill(signal: NodeJS.Signals): void { this.signals.push(signal); this.alive = false; }
  async waitForExit(): Promise<boolean> { return !this.alive; }
}

class FakeCgroup implements PiSandboxCgroup {
  applied?: PiSandboxLimits;
  attachedPid?: number;
  destroyed = false;

  async apply(value: PiSandboxLimits): Promise<void> { this.applied = value; }
  async attach(pid: number): Promise<void> { this.attachedPid = pid; }
  async usage(): Promise<Pick<PiSandboxUsage, "cpuMillis" | "memoryBytesPeak" | "pidsPeak">> { return { cpuMillis: 2, memoryBytesPeak: 3, pidsPeak: 4 }; }
  async destroy(): Promise<void> { this.destroyed = true; }
}

class FakeCgroupController implements PiSandboxCgroupController {
  readonly cgroup = new FakeCgroup();
  async readiness(): Promise<{ ready: true }> { return { ready: true }; }
  async create(): Promise<PiSandboxCgroup> { return this.cgroup; }
  async open(): Promise<PiSandboxCgroup> { return this.cgroup; }
  async verifyDestroyed(): Promise<boolean> { return true; }
}

class FakeGuestAgent implements PiSandboxGuestAgent {
  readonly calls: string[] = [];
  async health(): Promise<void> { this.calls.push("health"); }
  async mountWorkspace(mount: PiWorkspaceMount): Promise<void> { void mount; this.calls.push("mount"); }
  async applyNetworkPolicy(policy: PiCompiledEgressPolicy): Promise<void> { void policy; this.calls.push("network"); }
  async read(pathValue: string): Promise<PiSandboxFile> { this.calls.push("read"); return { path: pathValue, content: "hello", digest: "digest" }; }
  async list(): Promise<string[]> { this.calls.push("list"); return ["src"]; }
  async write(pathValue: string, content: string): Promise<PiSandboxFile> { this.calls.push("write"); return { path: pathValue, content, digest: "digest" }; }
  async applyPatch(pathValue: string, _oldText: string, newText: string): Promise<PiSandboxFile> { this.calls.push("patch"); return { path: pathValue, content: newText, digest: "digest" }; }
  async run(): Promise<PiSandboxResult> { this.calls.push("exec"); return { ok: true, output: "ok", exitCode: 0 }; }
  async snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { this.calls.push("snapshot"); return { files: [], diff: "", digest: "digest" }; }
  async collectUsage(): Promise<PiSandboxUsage> { this.calls.push("usage"); return { cpuMillis: 1, memoryBytesPeak: 1, pidsPeak: 1, diskBytes: 5, outputBytes: 6, collectedAt: new Date().toISOString() }; }
}

class FakeTransport implements FirecrackerApiTransport {
  readonly requests: FirecrackerApiRequest[] = [];
  async request(input: FirecrackerApiRequest): Promise<FirecrackerApiResponse> {
    this.requests.push(input);
    return { status: input.path === "/vm" ? 200 : 204, body: input.path === "/vm" ? { state: "Running" } : undefined };
  }
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
    limits,
  };
}

describe("Firecracker sandbox backend", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
  });

  it("configures a microVM through its Unix API contract and delegates IO to the guest agent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-firecracker-backend-"));
    directories.push(directory);
    const rootfs = path.join(directory, "rootfs.ext4");
    const kernel = path.join(directory, "vmlinux");
    const socketDirectory = await mkdtemp(path.join(path.parse(directory).root, "fc-socket-"));
    directories.push(socketDirectory);
    await writeFile(rootfs, "rootfs");
    await writeFile(kernel, "kernel");
    const processHandle = new FakeProcess();
    const transport = new FakeTransport();
    const agent = new FakeGuestAgent();
    const guestAgentFactory: PiSandboxGuestAgentFactory = () => agent;
    const backend = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      guestAgentFactory,
      transportFactory: () => transport,
      processFactory: async () => processHandle,
      cgroupController: new FakeCgroupController(),
      readinessOverride: async () => ({ ready: true }),
    });

    const sandbox = await backend.create(createSpec());
    expect(sandbox).toMatchObject({ provider: "firecracker", tenantId: "tenant-a", workspaceId: "workspace-a" });
    expect(transport.requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      "PUT /machine-config",
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /vsock",
      "PUT /actions",
    ]);
    expect((transport.requests[0].body as { vcpu_count: number; mem_size_mib: number })).toMatchObject({ vcpu_count: 2, mem_size_mib: 128 });
    expect((transport.requests[3].body as { guest_cid: number }).guest_cid).toBe(3);

    await expect(backend.read(sandbox, "src/index.ts")).resolves.toMatchObject({ content: "hello" });
    await expect(backend.run(sandbox, "npm test")).resolves.toMatchObject({ ok: true });
    await backend.mountWorkspace(sandbox, { sourceRef: "workspace://workspace-a", targetPath: "workspace", readOnly: true });
    await expect(backend.mountWorkspace(sandbox, { sourceRef: "file:///etc", targetPath: "workspace", readOnly: true })).rejects.toThrow("PI_SANDBOX_MOUNT_SOURCE_INVALID");
    await expect(backend.read(sandbox, "../outside.txt")).rejects.toThrow("PI_SANDBOX_PATH_INVALID");
    await backend.setLimits(sandbox, limits);
    await backend.applyNetworkPolicy(sandbox, { mode: "none", defaultAction: "deny", dnsMode: "deny", metadataBlocked: true, directEgress: false, destinations: [], digest: "sha256:test" });
    expect(agent.calls).toEqual(expect.arrayContaining(["health", "read", "exec", "mount", "network"]));
    await backend.terminate(sandbox, "test");
    expect(processHandle.signals).toContain("SIGTERM");
    await backend.destroy(sandbox);
    await expect(backend.verifyDestroyed(sandbox)).resolves.toBe(true);
  });

  it("rejects non-none networking without a dedicated network controller", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-firecracker-network-"));
    directories.push(directory);
    const rootfs = path.join(directory, "rootfs.ext4");
    const kernel = path.join(directory, "vmlinux");
    const socketDirectory = await mkdtemp(path.join(path.parse(directory).root, "fc-socket-"));
    directories.push(socketDirectory);
    await writeFile(rootfs, "rootfs");
    await writeFile(kernel, "kernel");
    const backend = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      processFactory: async () => new FakeProcess(),
      cgroupController: new FakeCgroupController(),
      readinessOverride: async () => ({ ready: true }),
    });
    await expect(backend.create({ ...createSpec(), networkPolicy: "restricted", egressPolicy: { mode: "restricted", proxyRef: "proxy-a" } })).rejects.toThrow("PI_SANDBOX_NETWORK_CONTROLLER_REQUIRED");
  });

  it("revalidates the VMM executable identity and all residual paths during recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-firecracker-recovery-"));
    directories.push(directory);
    const rootfs = path.join(directory, "rootfs.ext4");
    const kernel = path.join(directory, "vmlinux");
    const socketDirectory = await mkdtemp(path.join(path.parse(directory).root, "fc-socket-recovery-"));
    directories.push(socketDirectory);
    await writeFile(rootfs, "rootfs");
    await writeFile(kernel, "kernel");
    const processHandle = new FakeProcess();
    const transport = new FakeTransport();
    const agent = new FakeGuestAgent();
    const cgroupController = new FakeCgroupController();
    const first = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      guestAgentFactory: () => agent,
      transportFactory: () => transport,
      processFactory: async () => processHandle,
      cgroupController,
      readinessOverride: async () => ({ ready: true }),
    });
    const sandbox = await first.create(createSpec());
    let reconnect: { pid: number; apiSocketPath: string; runtimePath: string } | undefined;
    const second = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      guestAgentFactory: () => agent,
      transportFactory: () => transport,
      processReconnector: async (pid, apiSocketPath, runtimePath) => {
        reconnect = { pid, apiSocketPath, runtimePath };
        return processHandle;
      },
      cgroupController,
      readinessOverride: async () => ({ ready: true }),
    });

    await expect(second.read(sandbox, "src/index.ts")).resolves.toMatchObject({ content: "hello" });
    expect(reconnect).toMatchObject({ pid: processHandle.pid, runtimePath: "/usr/bin/firecracker" });
    processHandle.kill("SIGKILL");
    await expect(second.verifyDestroyed(sandbox)).resolves.toBe(false);
    await rm(path.join(directory, "sandboxes", sandbox.id), { recursive: true, force: true });
    await rm(path.join(socketDirectory, sandbox.id), { recursive: true, force: true });
    await expect(second.verifyDestroyed(sandbox)).resolves.toBe(true);
  });

  it("rejects tampered runtime network policy metadata before reconnecting a process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-firecracker-metadata-"));
    directories.push(directory);
    const rootfs = path.join(directory, "rootfs.ext4");
    const kernel = path.join(directory, "vmlinux");
    const socketDirectory = await mkdtemp(path.join(path.parse(directory).root, "fc-socket-metadata-"));
    directories.push(socketDirectory);
    await writeFile(rootfs, "rootfs");
    await writeFile(kernel, "kernel");
    const processHandle = new FakeProcess();
    const first = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      transportFactory: () => new FakeTransport(),
      guestAgentFactory: () => new FakeGuestAgent(),
      processFactory: async () => processHandle,
      cgroupController: new FakeCgroupController(),
      readinessOverride: async () => ({ ready: true }),
    });
    const sandbox = await first.create(createSpec());
    const metadataPath = path.join(directory, "sandboxes", sandbox.id, "runtime.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { networkPolicy: { defaultAction: string } };
    metadata.networkPolicy.defaultAction = "allow";
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
    const second = new FirecrackerSandboxBackend({
      runtimePath: "/usr/bin/firecracker",
      stateDirectory: directory,
      socketDirectory,
      rootfsImage: rootfs,
      kernelImage: kernel,
      processReconnector: async () => { throw new Error("PROCESS_MUST_NOT_RECONNECT"); },
      cgroupController: new FakeCgroupController(),
      readinessOverride: async () => ({ ready: true }),
    });
    await expect(second.read(sandbox, "src/index.ts")).rejects.toThrow("PI_SANDBOX_RUNTIME_METADATA_UNAVAILABLE");
  });
});
