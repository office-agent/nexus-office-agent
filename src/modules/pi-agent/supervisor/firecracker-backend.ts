import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  PiCompiledEgressPolicy,
  PiSandbox,
  PiSandboxFile,
  PiSandboxLimits,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
  PiWorkspaceMount,
  PiEgressDestination,
} from "@/src/modules/pi-agent/domain/contracts";
import { defaultEgressPolicyCompiler } from "@/src/modules/pi-agent/application/sandbox-policy";
import { DEFAULT_PI_SANDBOX_LIMITS } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import type { PiSandboxSupervisorBackend } from "@/src/modules/pi-agent/supervisor/contracts";
import { FilePiSandboxCgroupController, type PiSandboxCgroup, type PiSandboxCgroupController } from "@/src/modules/pi-agent/supervisor/cgroup";
import {
  FirecrackerApiClient,
  type FirecrackerApiTransport,
  type FirecrackerConfiguration,
  UnixSocketFirecrackerApiTransport,
} from "@/src/modules/pi-agent/supervisor/firecracker-api";
import { createVsockPiSandboxGuestAgent, type PiSandboxGuestAgent, type PiSandboxGuestAgentFactory } from "@/src/modules/pi-agent/supervisor/guest-agent";

const DEFAULT_GUEST_PORT = 5_000;
const DEFAULT_GUEST_CID = 3;
const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init";
const API_SOCKET_NAME = "firecracker.sock";
const VSOCK_SOCKET_NAME = "vsock.sock";
const METADATA_NAME = "runtime.json";
const MAX_TERMINATE_WAIT_MS = 3_000;
const MAX_GUEST_PATH_LENGTH = 4_096;
const MAX_GUEST_TEXT_BYTES = 1_500_000;
const ALLOWED_WORKSPACE_REF_SCHEMES = new Set(["workspace:", "virtual:", "forgejo:"]);

type FirecrackerProcess = {
  readonly pid: number;
  isAlive(): Promise<boolean>;
  kill(signal: NodeJS.Signals): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
};

export type FirecrackerProcessFactory = (input: {
  runtimePath: string;
  apiSocketPath: string;
  workingDirectory: string;
}) => Promise<FirecrackerProcess>;

export interface FirecrackerNetworkController {
  prepare(sandbox: PiSandbox, api: FirecrackerApiClient, policy: PiCompiledEgressPolicy): Promise<void>;
  apply(sandbox: PiSandbox, policy: PiCompiledEgressPolicy): Promise<void>;
  destroy(sandbox: PiSandbox): Promise<void>;
}

export type FirecrackerBackendOptions = {
  runtimePath: string;
  stateDirectory: string;
  socketDirectory?: string;
  rootfsImage: string;
  kernelImage: string;
  guestAgentFactory?: PiSandboxGuestAgentFactory;
  transportFactory?: (socketPath: string) => FirecrackerApiTransport;
  processFactory?: FirecrackerProcessFactory;
  processReconnector?: (pid: number, apiSocketPath: string, runtimePath: string) => Promise<FirecrackerProcess>;
  cgroupController?: PiSandboxCgroupController;
  networkController?: FirecrackerNetworkController;
  guestPort?: number;
  guestCid?: number;
  bootArgs?: string;
  now?: () => Date;
  readinessOverride?: () => Promise<{ ready: true } | { ready: false; code: string }>;
};

type RuntimeMetadata = {
  schemaVersion: 1;
  sandboxId: string;
  pid: number;
  apiSocketPath: string;
  vsockSocketPath: string;
  limits: PiSandboxLimits;
  networkPolicy: PiCompiledEgressPolicy;
  createdAt: string;
};

type RuntimeState = {
  sandbox: PiSandbox;
  directory: string;
  apiSocketPath: string;
  vsockSocketPath: string;
  process: FirecrackerProcess;
  api: FirecrackerApiClient;
  agent: PiSandboxGuestAgent;
  cgroup: PiSandboxCgroup;
  networkPolicy: PiCompiledEgressPolicy;
};

function assertAbsolutePath(value: string, code: string): void {
  if (!path.isAbsolute(value) || value.length > 4_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(code);
}

function assertDirectoryPath(value: string): void {
  assertAbsolutePath(value, "PI_SANDBOX_STATE_DIRECTORY_INVALID");
  if (path.resolve(value) === path.parse(path.resolve(value)).root) throw new Error("PI_SANDBOX_STATE_DIRECTORY_INVALID");
}

function assertSandboxId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("PI_SANDBOX_ID_INVALID");
}

function assertIdentity(spec: PiSandboxSpec): void {
  for (const value of [spec.tenantId, spec.actorId, spec.sessionId, spec.workspaceId, spec.runId]) {
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("PI_SANDBOX_SCOPE_INVALID");
  }
}

function assertLimits(limits: PiSandboxLimits): void {
  if (!Number.isInteger(limits.cpuMillis) || limits.cpuMillis < 100 || limits.cpuMillis > 64_000) throw new Error("PI_SANDBOX_CPU_LIMIT_INVALID");
  if (!Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024 * 1024 || limits.memoryBytes > 256 * 1024 * 1024 * 1024) throw new Error("PI_SANDBOX_MEMORY_LIMIT_INVALID");
  if (!Number.isInteger(limits.pids) || limits.pids < 16 || limits.pids > 16_384) throw new Error("PI_SANDBOX_PID_LIMIT_INVALID");
  if (!Number.isInteger(limits.diskBytes) || limits.diskBytes < 16 * 1024 * 1024 || limits.diskBytes > 1024 * 1024 * 1024 * 1024) throw new Error("PI_SANDBOX_DISK_LIMIT_INVALID");
  if (!Number.isInteger(limits.maxDurationMs) || limits.maxDurationMs < 1_000 || limits.maxDurationMs > 24 * 60 * 60 * 1000) throw new Error("PI_SANDBOX_DURATION_LIMIT_INVALID");
  if (!Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1_024 || limits.maxOutputBytes > 100 * 1024 * 1024) throw new Error("PI_SANDBOX_OUTPUT_LIMIT_INVALID");
}

function assertMount(mount: PiWorkspaceMount): void {
  if (!mount.sourceRef || mount.sourceRef.length > 1_000 || !/^[a-z][a-z0-9+.-]*:\/\//i.test(mount.sourceRef)) throw new Error("PI_SANDBOX_MOUNT_SOURCE_INVALID");
  try {
    const source = new URL(mount.sourceRef);
    if (!ALLOWED_WORKSPACE_REF_SCHEMES.has(source.protocol) || !source.hostname || source.username || source.password || source.port || source.search || source.hash) throw new Error("PI_SANDBOX_MOUNT_SOURCE_INVALID");
  } catch {
    throw new Error("PI_SANDBOX_MOUNT_SOURCE_INVALID");
  }
  if (!mount.targetPath || mount.targetPath.length > MAX_GUEST_PATH_LENGTH || mount.targetPath.startsWith("/") || mount.targetPath.includes("\\") || /[\u0000-\u001f\u007f]/.test(mount.targetPath) || mount.targetPath.split("/").some((part) => part === "..")) throw new Error("PI_SANDBOX_MOUNT_TARGET_INVALID");
}

function assertGuestPath(value: string): void {
  if (!value || value.length > MAX_GUEST_PATH_LENGTH || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || value.split("/").some((part) => part === "..")) throw new Error("PI_SANDBOX_PATH_INVALID");
}

function assertGuestText(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_GUEST_TEXT_BYTES) throw new Error("PI_SANDBOX_CONTENT_TOO_LARGE");
}

function assertCommand(command: string): void {
  if (!command || command.length > 128_000 || /[\u0000]/.test(command)) throw new Error("PI_SANDBOX_COMMAND_INVALID");
}

function childProcess(input: { runtimePath: string; apiSocketPath: string; workingDirectory: string }): Promise<FirecrackerProcess> {
  assertAbsolutePath(input.apiSocketPath, "PI_FIRECRACKER_API_SOCKET_PATH_INVALID");
  const child: ChildProcess = spawn(input.runtimePath, ["--api-sock", input.apiSocketPath], {
    cwd: input.workingDirectory,
    shell: false,
    detached: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    } as unknown as NodeJS.ProcessEnv,
  });
  child.stderr?.resume();
  if (!child.pid) return Promise.reject(new Error("PI_FIRECRACKER_PROCESS_PID_MISSING"));
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (exited || child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
    child.once("error", () => { clearTimeout(timer); resolve(true); });
  });
  return Promise.resolve({
    pid: child.pid,
    isAlive: async () => !exited && child.exitCode === null,
    kill: (signal: NodeJS.Signals) => { if (!exited) child.kill(signal); },
    waitForExit,
  });
}

async function attachedProcess(pid: number, apiSocketPath: string, runtimePath: string): Promise<FirecrackerProcess> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("PI_FIRECRACKER_PROCESS_PID_INVALID");
  if (process.platform !== "linux") throw new Error("PI_FIRECRACKER_PROCESS_LINUX_REQUIRED");
  const commandLinePath = `/proc/${pid}/cmdline`;
  const commandLine = await readFile(commandLinePath, "utf8").catch(() => "");
  if (!commandLine || !commandLine.includes("--api-sock") || !commandLine.includes(apiSocketPath)) throw new Error("PI_FIRECRACKER_PROCESS_IDENTITY_INVALID");
  const [expectedExecutable, actualExecutable] = await Promise.all([
    realpath(runtimePath).catch(() => ""),
    realpath(`/proc/${pid}/exe`).catch(() => ""),
  ]);
  if (!expectedExecutable || !actualExecutable || expectedExecutable !== actualExecutable) throw new Error("PI_FIRECRACKER_PROCESS_IDENTITY_INVALID");
  let lastKnownAlive = true;
  const isAlive = async () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      lastKnownAlive = false;
      return false;
    }
  };
  return {
    pid,
    isAlive,
    kill: (signal: NodeJS.Signals) => { if (lastKnownAlive) process.kill(pid, signal); },
    waitForExit: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!(await isAlive())) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return !(await isAlive());
    },
  };
}

async function fileExists(value: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const result = await stat(value);
    return kind === "file" ? result.isFile() : result.isDirectory();
  } catch {
    return false;
  }
}

function defaultNetworkPolicy(spec: PiSandboxSpec): PiCompiledEgressPolicy {
  return defaultEgressPolicyCompiler.compile(spec.egressPolicy ?? { mode: spec.networkPolicy });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRuntimeNetworkPolicy(value: unknown): asserts value is PiCompiledEgressPolicy {
  if (!isRecord(value) || (value.mode !== "none" && value.mode !== "allowlist" && value.mode !== "restricted") || !Array.isArray(value.destinations)) {
    throw new Error("PI_SANDBOX_RUNTIME_METADATA_INVALID");
  }
  const compiled = defaultEgressPolicyCompiler.compile({
    mode: value.mode,
    destinations: value.destinations as PiEgressDestination[],
    proxyRef: typeof value.proxyRef === "string" ? value.proxyRef : undefined,
  });
  if (
    value.digest !== compiled.digest
    || value.defaultAction !== compiled.defaultAction
    || value.dnsMode !== compiled.dnsMode
    || value.metadataBlocked !== compiled.metadataBlocked
    || value.directEgress !== compiled.directEgress
    || JSON.stringify(value.destinations) !== JSON.stringify(compiled.destinations)
    || value.proxyRef !== compiled.proxyRef
  ) throw new Error("PI_SANDBOX_RUNTIME_METADATA_INVALID");
}

function waitSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("PI_SANDBOX_ABORTED");
}

export class FirecrackerSandboxBackend implements PiSandboxSupervisorBackend {
  readonly kind = "firecracker" as const;
  private readonly states = new Map<string, RuntimeState>();
  private readonly runtimePath: string;
  private readonly stateDirectory: string;
  private readonly socketDirectory: string;
  private readonly rootfsImage: string;
  private readonly kernelImage: string;
  private readonly guestAgentFactory: PiSandboxGuestAgentFactory;
  private readonly transportFactory: (socketPath: string) => FirecrackerApiTransport;
  private readonly processFactory: FirecrackerProcessFactory;
  private readonly processReconnector: (pid: number, apiSocketPath: string, runtimePath: string) => Promise<FirecrackerProcess>;
  private readonly cgroupController: PiSandboxCgroupController;
  private readonly networkController?: FirecrackerNetworkController;
  private readonly guestPort: number;
  private readonly guestCid: number;
  private readonly bootArgs: string;
  private readonly now: () => Date;
  private readonly readinessOverride?: () => Promise<{ ready: true } | { ready: false; code: string }>;

  constructor(options: FirecrackerBackendOptions) {
    assertAbsolutePath(options.runtimePath, "PI_FIRECRACKER_RUNTIME_PATH_INVALID");
    assertDirectoryPath(options.stateDirectory);
    assertDirectoryPath(options.socketDirectory ?? options.stateDirectory);
    assertAbsolutePath(options.rootfsImage, "PI_SANDBOX_ROOTFS_IMAGE_INVALID");
    assertAbsolutePath(options.kernelImage, "PI_SANDBOX_KERNEL_IMAGE_INVALID");
    if (!Number.isInteger(options.guestPort ?? DEFAULT_GUEST_PORT) || (options.guestPort ?? DEFAULT_GUEST_PORT) < 1024 || (options.guestPort ?? DEFAULT_GUEST_PORT) > 65535) throw new Error("PI_SANDBOX_GUEST_PORT_INVALID");
    if (!Number.isInteger(options.guestCid ?? DEFAULT_GUEST_CID) || (options.guestCid ?? DEFAULT_GUEST_CID) < 3 || (options.guestCid ?? DEFAULT_GUEST_CID) > 4_294_967_295) throw new Error("PI_SANDBOX_GUEST_CID_INVALID");
    this.runtimePath = options.runtimePath;
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.socketDirectory = path.resolve(options.socketDirectory ?? options.stateDirectory);
    this.rootfsImage = options.rootfsImage;
    this.kernelImage = options.kernelImage;
    this.guestAgentFactory = options.guestAgentFactory ?? createVsockPiSandboxGuestAgent;
    this.transportFactory = options.transportFactory ?? ((socketPath) => new UnixSocketFirecrackerApiTransport(socketPath));
    this.processFactory = options.processFactory ?? childProcess;
    this.processReconnector = options.processReconnector ?? attachedProcess;
    this.cgroupController = options.cgroupController ?? new FilePiSandboxCgroupController();
    this.networkController = options.networkController;
    this.guestPort = options.guestPort ?? DEFAULT_GUEST_PORT;
    this.guestCid = options.guestCid ?? DEFAULT_GUEST_CID;
    this.bootArgs = options.bootArgs ?? DEFAULT_BOOT_ARGS;
    this.now = options.now ?? (() => new Date());
    this.readinessOverride = options.readinessOverride;
  }

  async readiness(): Promise<{ ready: true } | { ready: false; code: string }> {
    if (process.platform !== "linux") return { ready: false, code: "PI_SANDBOX_FIRECRACKER_LINUX_REQUIRED" };
    if (!(await fileExists(this.runtimePath, "file"))) return { ready: false, code: "PI_SANDBOX_RUNTIME_BINARY_UNAVAILABLE" };
    if (!(await fileExists(this.rootfsImage, "file"))) return { ready: false, code: "PI_SANDBOX_ROOTFS_IMAGE_UNAVAILABLE" };
    if (!(await fileExists(this.kernelImage, "file"))) return { ready: false, code: "PI_SANDBOX_KERNEL_IMAGE_UNAVAILABLE" };
    if (!(await fileExists(this.stateDirectory, "directory"))) {
      try { await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 }); } catch { return { ready: false, code: "PI_SANDBOX_STATE_DIRECTORY_UNAVAILABLE" }; }
    }
    try {
      await access("/dev/kvm", constants.R_OK | constants.W_OK);
      await access("/dev/vhost-vsock", constants.R_OK | constants.W_OK);
    } catch {
      return { ready: false, code: "PI_SANDBOX_MICROVM_DEVICE_UNAVAILABLE" };
    }
    const cgroup = await this.cgroupController.readiness();
    if (!cgroup.ready) return cgroup;
    if (this.networkController) return { ready: true };
    return { ready: true };
  }

  private runtimeDirectory(sandboxId: string): string {
    assertSandboxId(sandboxId);
    const directory = path.resolve(this.stateDirectory, "sandboxes", sandboxId);
    const parent = path.resolve(this.stateDirectory, "sandboxes");
    if (!directory.startsWith(`${parent}${path.sep}`)) throw new Error("PI_SANDBOX_RUNTIME_PATH_INVALID");
    return directory;
  }

  private socketDirectoryFor(sandboxId: string): string {
    assertSandboxId(sandboxId);
    const directory = path.resolve(this.socketDirectory, sandboxId);
    const parent = path.resolve(this.socketDirectory);
    if (!directory.startsWith(`${parent}${path.sep}`)) throw new Error("PI_SANDBOX_SOCKET_DIRECTORY_INVALID");
    return directory;
  }

  private async metadata(directory: string): Promise<RuntimeMetadata> {
    try {
      const value = JSON.parse(await readFile(path.join(directory, METADATA_NAME), "utf8")) as Partial<RuntimeMetadata>;
      if (
        value.schemaVersion !== 1
        || typeof value.sandboxId !== "string"
        || typeof value.pid !== "number"
        || !Number.isInteger(value.pid)
        || value.pid <= 0
        || typeof value.apiSocketPath !== "string"
        || typeof value.vsockSocketPath !== "string"
        || !value.limits
        || !value.networkPolicy
        || typeof value.createdAt !== "string"
        || !Number.isFinite(Date.parse(value.createdAt))
      ) throw new Error("PI_SANDBOX_RUNTIME_METADATA_INVALID");
      assertSandboxId(value.sandboxId);
      assertLimits(value.limits);
      assertRuntimeNetworkPolicy(value.networkPolicy);
      return value as RuntimeMetadata;
    } catch {
      throw new Error("PI_SANDBOX_RUNTIME_METADATA_UNAVAILABLE");
    }
  }

  private async recover(sandbox: PiSandbox): Promise<RuntimeState> {
    const directory = this.runtimeDirectory(sandbox.id);
    const metadata = await this.metadata(directory);
    const socketDirectory = this.socketDirectoryFor(sandbox.id);
    if (metadata.sandboxId !== sandbox.id || metadata.apiSocketPath !== path.join(socketDirectory, API_SOCKET_NAME) || metadata.vsockSocketPath !== path.join(socketDirectory, VSOCK_SOCKET_NAME)) throw new Error("PI_SANDBOX_RUNTIME_METADATA_SCOPE_MISMATCH");
    const processHandle = await this.processReconnector(metadata.pid, metadata.apiSocketPath, this.runtimePath);
    if (!(await processHandle.isAlive())) throw new Error("PI_SANDBOX_PROCESS_NOT_RUNNING");
    const api = new FirecrackerApiClient(this.transportFactory(metadata.apiSocketPath));
    await api.getVm();
    assertLimits(metadata.limits);
    if (metadata.networkPolicy.mode !== "none" && !this.networkController) throw new Error("PI_SANDBOX_NETWORK_CONTROLLER_REQUIRED");
    const cgroup = this.cgroupController.open
      ? await this.cgroupController.open(sandbox.id, metadata.limits, metadata.pid).catch(() => undefined)
      : undefined;
    if (!cgroup) throw new Error("PI_SANDBOX_CGROUP_RECOVERY_UNAVAILABLE");
    const agent = this.guestAgentFactory({ sandbox, vsockSocketPath: metadata.vsockSocketPath, guestPort: this.guestPort });
    if (metadata.networkPolicy.mode !== "none") await this.networkController!.apply(sandbox, metadata.networkPolicy);
    const state: RuntimeState = { sandbox, directory, apiSocketPath: metadata.apiSocketPath, vsockSocketPath: metadata.vsockSocketPath, process: processHandle, api, agent, cgroup, networkPolicy: metadata.networkPolicy };
    this.states.set(sandbox.id, state);
    return state;
  }

  private async state(sandbox: PiSandbox): Promise<RuntimeState> {
    if (sandbox.provider !== "firecracker") throw new Error("PI_SANDBOX_PROVIDER_MISMATCH");
    if (sandbox.tenantId === undefined || sandbox.actorId === undefined || sandbox.sessionId === undefined || sandbox.workspaceId === undefined || sandbox.runId === undefined) throw new Error("PI_SANDBOX_SCOPE_MISSING");
    const existing = this.states.get(sandbox.id);
    if (existing) {
      if (existing.sandbox.tenantId !== sandbox.tenantId || existing.sandbox.actorId !== sandbox.actorId || existing.sandbox.sessionId !== sandbox.sessionId || existing.sandbox.workspaceId !== sandbox.workspaceId || existing.sandbox.runId !== sandbox.runId) throw new Error("PI_SANDBOX_SCOPE_MISMATCH");
      return existing;
    }
    return this.recover(sandbox);
  }

  private async waitForAgent(agent: PiSandboxGuestAgent, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      waitSignal(signal);
      try {
        await agent.health();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("PI_SANDBOX_GUEST_AGENT_UNAVAILABLE");
  }

  async create(spec: PiSandboxSpec, signal?: AbortSignal): Promise<PiSandbox> {
    const readiness = await (this.readinessOverride ? this.readinessOverride() : this.readiness());
    if (!readiness.ready) throw new Error(readiness.code);
    if (spec.networkPolicy !== "none" && !this.networkController) throw new Error("PI_SANDBOX_NETWORK_CONTROLLER_REQUIRED");
    assertIdentity(spec);
    waitSignal(signal);
    const limits = spec.limits ?? DEFAULT_PI_SANDBOX_LIMITS;
    assertLimits(limits);
    if (!(await fileExists(this.rootfsImage, "file")) || !(await fileExists(this.kernelImage, "file"))) throw new Error("PI_SANDBOX_IMAGE_UNAVAILABLE");
    await mkdir(path.join(this.stateDirectory, "sandboxes"), { recursive: true, mode: 0o700 });
    const id = `fc-${randomUUID()}`;
    const directory = this.runtimeDirectory(id);
    const socketDirectory = this.socketDirectoryFor(id);
    const apiSocketPath = path.join(socketDirectory, API_SOCKET_NAME);
    const vsockSocketPath = path.join(socketDirectory, VSOCK_SOCKET_NAME);
    if (apiSocketPath.length > 100 || vsockSocketPath.length > 100) throw new Error("PI_SANDBOX_SOCKET_PATH_TOO_LONG");
    const sandbox: PiSandbox = { id, root: directory, provider: "firecracker", tenantId: spec.tenantId, actorId: spec.actorId, sessionId: spec.sessionId, workspaceId: spec.workspaceId, runId: spec.runId };
    let processHandle: FirecrackerProcess | undefined;
    let cgroup: PiSandboxCgroup | undefined;
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      await mkdir(socketDirectory, { recursive: false, mode: 0o700 });
      cgroup = await this.cgroupController.create(id, limits);
      processHandle = await this.processFactory({ runtimePath: this.runtimePath, apiSocketPath, workingDirectory: directory });
      await cgroup.attach(processHandle.pid);
      const api = new FirecrackerApiClient(this.transportFactory(apiSocketPath));
      const configuration: FirecrackerConfiguration = {
        machineConfig: { vcpu_count: Math.max(1, Math.ceil(limits.cpuMillis / 1_000)), mem_size_mib: Math.max(64, Math.ceil(limits.memoryBytes / (1024 * 1024))), smt: false },
        bootSource: { kernel_image_path: this.kernelImage, boot_args: this.bootArgs },
        rootfs: { drive_id: "rootfs", path_on_host: this.rootfsImage, is_root_device: true, is_read_only: true },
        vsock: { vsock_id: "root", guest_cid: this.guestCid, uds_path: vsockSocketPath },
      };
      await api.configure(configuration);
      const networkPolicy = defaultNetworkPolicy(spec);
      if (networkPolicy.mode !== "none") await this.networkController!.prepare(sandbox, api, networkPolicy);
      await writeFile(path.join(directory, METADATA_NAME), JSON.stringify({ schemaVersion: 1, sandboxId: id, pid: processHandle.pid, apiSocketPath, vsockSocketPath, limits, networkPolicy, createdAt: this.now().toISOString() } satisfies RuntimeMetadata), { encoding: "utf8", mode: 0o600 });
      await api.start();
      const agent = this.guestAgentFactory({ sandbox, vsockSocketPath, guestPort: this.guestPort });
      await this.waitForAgent(agent, signal);
      const state: RuntimeState = { sandbox, directory, apiSocketPath, vsockSocketPath, process: processHandle, api, agent, cgroup, networkPolicy };
      this.states.set(id, state);
      return sandbox;
    } catch (error) {
      if (processHandle) {
        processHandle.kill("SIGKILL");
        await processHandle.waitForExit(1_000);
      }
      await cgroup?.destroy().catch(() => undefined);
      if (this.networkController) await this.networkController.destroy(sandbox).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      await rm(socketDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async mountWorkspace(sandbox: PiSandbox, mount: PiWorkspaceMount): Promise<void> { assertMount(mount); await (await this.state(sandbox)).agent.mountWorkspace(mount); }
  async setLimits(sandbox: PiSandbox, limits: PiSandboxLimits): Promise<void> { assertLimits(limits); await (await this.state(sandbox)).cgroup.apply(limits); }
  async applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy): Promise<void> {
    if (policy.mode !== "none" && !this.networkController) throw new Error("PI_SANDBOX_NETWORK_CONTROLLER_REQUIRED");
    const state = await this.state(sandbox);
    if (policy.mode !== "none") await this.networkController!.apply(sandbox, policy);
    await state.agent.applyNetworkPolicy(policy);
    state.networkPolicy = policy;
  }
  async read(sandbox: PiSandbox, pathValue: string): Promise<PiSandboxFile> { assertGuestPath(pathValue); return (await this.state(sandbox)).agent.read(pathValue); }
  async list(sandbox: PiSandbox, pathValue: string): Promise<string[]> { assertGuestPath(pathValue); return (await this.state(sandbox)).agent.list(pathValue); }
  async write(sandbox: PiSandbox, pathValue: string, content: string): Promise<PiSandboxFile> { assertGuestPath(pathValue); assertGuestText(content); return (await this.state(sandbox)).agent.write(pathValue, content); }
  async applyPatch(sandbox: PiSandbox, pathValue: string, oldText: string, newText: string): Promise<PiSandboxFile> { assertGuestPath(pathValue); assertGuestText(oldText); assertGuestText(newText); return (await this.state(sandbox)).agent.applyPatch(pathValue, oldText, newText); }
  async run(sandbox?: PiSandbox, command?: string, signal?: AbortSignal): Promise<PiSandboxResult> {
    if (!sandbox || command === undefined) throw new Error("PI_SANDBOX_INPUT_INVALID");
    assertCommand(command);
    return (await this.state(sandbox)).agent.run(command, signal);
  }
  async snapshot(sandbox: PiSandbox): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return (await this.state(sandbox)).agent.snapshot(); }
  async collectUsage(sandbox: PiSandbox): Promise<PiSandboxUsage> {
    const state = await this.state(sandbox);
    const [guest, cgroup] = await Promise.all([state.agent.collectUsage(), state.cgroup.usage()]);
    return { ...guest, cpuMillis: Math.max(guest.cpuMillis, cgroup.cpuMillis), memoryBytesPeak: Math.max(guest.memoryBytesPeak, cgroup.memoryBytesPeak), pidsPeak: Math.max(guest.pidsPeak, cgroup.pidsPeak), collectedAt: this.now().toISOString() };
  }

  async terminate(sandbox: PiSandbox, _reason: string): Promise<void> {
    if (_reason.length > 500 || /[\u0000-\u001f\u007f]/.test(_reason)) throw new Error("PI_SANDBOX_TERMINATION_REASON_INVALID");
    const state = await this.state(sandbox);
    if (!(await state.process.isAlive())) return;
    await state.api.sendCtrlAltDel().catch(() => undefined);
    if (await state.process.waitForExit(MAX_TERMINATE_WAIT_MS)) return;
    state.process.kill("SIGTERM");
    if (await state.process.waitForExit(1_000)) return;
    state.process.kill("SIGKILL");
    await state.process.waitForExit(1_000);
  }

  async destroy(sandbox: PiSandbox): Promise<void> {
    const state = await this.state(sandbox);
    await this.terminate(sandbox, "destroy");
    if (await state.process.isAlive()) throw new Error("PI_SANDBOX_PROCESS_STILL_RUNNING");
    if (this.networkController) await this.networkController.destroy(sandbox);
    await state.cgroup.destroy();
    await rm(state.directory, { recursive: true, force: false });
    await rm(this.socketDirectoryFor(sandbox.id), { recursive: true, force: false });
    this.states.delete(sandbox.id);
  }

  async verifyDestroyed(sandbox: PiSandbox): Promise<boolean> {
    try {
      const state = this.states.get(sandbox.id);
      if (state && await state.process.isAlive()) return false;
      const runtimeGone = !(await fileExists(this.runtimeDirectory(sandbox.id), "directory"));
      const socketGone = !(await fileExists(this.socketDirectoryFor(sandbox.id), "directory"));
      const cgroupGone = this.cgroupController.verifyDestroyed
        ? await this.cgroupController.verifyDestroyed(sandbox.id)
        : false;
      return runtimeGone && socketGone && cgroupGone;
    } catch {
      return false;
    }
  }
}
