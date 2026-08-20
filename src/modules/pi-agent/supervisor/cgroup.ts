import { access, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { PiSandboxLimits, PiSandboxUsage } from "@/src/modules/pi-agent/domain/contracts";

export interface PiSandboxCgroup {
  apply(limits: PiSandboxLimits): Promise<void>;
  attach(pid: number): Promise<void>;
  usage(): Promise<Pick<PiSandboxUsage, "cpuMillis" | "memoryBytesPeak" | "pidsPeak">>;
  destroy(): Promise<void>;
}

export interface PiSandboxCgroupController {
  readiness(): Promise<{ ready: true } | { ready: false; code: string }>;
  create(id: string, limits: PiSandboxLimits): Promise<PiSandboxCgroup>;
  /** Reopen only after proving that the recorded VMM PID is a member. */
  open?(id: string, limits: PiSandboxLimits, pid: number): Promise<PiSandboxCgroup>;
  /** Confirm that the cgroup directory no longer exists after destruction. */
  verifyDestroyed?(id: string): Promise<boolean>;
}

function assertId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("PI_SANDBOX_CGROUP_ID_INVALID");
}

function assertRoot(value: string): void {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root || resolved === "/sys/fs/cgroup") throw new Error("PI_SANDBOX_CGROUP_ROOT_INVALID");
}

function cpuMax(limits: PiSandboxLimits): string {
  const period = 100_000;
  return `${Math.max(1_000, Math.floor(limits.cpuMillis * period / 1_000))} ${period}`;
}

function parseCpuMillis(value: string): number {
  const usage = value.split(/\s+/).find((item) => item.startsWith("usage_usec "));
  return usage ? Math.floor(Number(usage.split(" ")[1]) / 1_000) : 0;
}

function parseNumber(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

class FilePiSandboxCgroup implements PiSandboxCgroup {
  constructor(private readonly directory: string) {}

  async apply(limits: PiSandboxLimits): Promise<void> {
    await writeFile(path.join(this.directory, "cpu.max"), cpuMax(limits), "utf8");
    await writeFile(path.join(this.directory, "memory.max"), String(limits.memoryBytes), "utf8");
    await writeFile(path.join(this.directory, "memory.swap.max"), "0", "utf8").catch(() => undefined);
    await writeFile(path.join(this.directory, "pids.max"), String(limits.pids), "utf8");
  }

  async attach(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("PI_SANDBOX_PROCESS_PID_INVALID");
    await writeFile(path.join(this.directory, "cgroup.procs"), String(pid), "utf8");
  }

  async usage(): Promise<Pick<PiSandboxUsage, "cpuMillis" | "memoryBytesPeak" | "pidsPeak">> {
    const [cpu, memory, pids] = await Promise.all([
      readFile(path.join(this.directory, "cpu.stat"), "utf8").catch(() => ""),
      readFile(path.join(this.directory, "memory.peak"), "utf8").catch(() => "0"),
      readFile(path.join(this.directory, "pids.peak"), "utf8").catch(() => "0"),
    ]);
    return { cpuMillis: parseCpuMillis(cpu), memoryBytesPeak: parseNumber(memory), pidsPeak: parseNumber(pids) };
  }

  async destroy(): Promise<void> {
    await rmdir(this.directory);
  }
}

/**
 * Minimal cgroup-v2 controller for the Firecracker VMM process. It deliberately
 * does not pretend that disk quotas are enforced by cgroup-v2; disk limits
 * remain a guest image/Guest Agent responsibility until an image controller is
 * configured.
 */
export class FilePiSandboxCgroupController implements PiSandboxCgroupController {
  private readonly root: string;

  constructor(root = process.env.NEXUS_PI_CGROUP_ROOT ?? "/sys/fs/cgroup/nexus-pi") {
    assertRoot(root);
    this.root = path.resolve(root);
  }

  async readiness(): Promise<{ ready: true } | { ready: false; code: string }> {
    if (process.platform !== "linux") return { ready: false, code: "PI_SANDBOX_CGROUP_LINUX_REQUIRED" };
    try {
      const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
      const available = new Set(controllers.split(/\s+/).filter(Boolean));
      if (!["cpu", "memory", "pids"].every((item) => available.has(item))) return { ready: false, code: "PI_SANDBOX_CGROUP_CONTROLLERS_MISSING" };
      await mkdir(this.root, { recursive: true, mode: 0o750 });
      await access(this.root, constants.R_OK | constants.W_OK | constants.X_OK);
      return { ready: true };
    } catch {
      return { ready: false, code: "PI_SANDBOX_CGROUP_UNAVAILABLE" };
    }
  }

  async create(id: string, limits: PiSandboxLimits): Promise<PiSandboxCgroup> {
    assertId(id);
    const directory = path.join(this.root, id);
    await mkdir(directory, { mode: 0o750 });
    const cgroup = new FilePiSandboxCgroup(directory);
    try {
      await cgroup.apply(limits);
      return cgroup;
    } catch (error) {
      await cgroup.destroy().catch(() => undefined);
      throw error;
    }
  }

  async open(id: string, limits: PiSandboxLimits, pid: number): Promise<PiSandboxCgroup> {
    assertId(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("PI_SANDBOX_PROCESS_PID_INVALID");
    const directory = path.join(this.root, id);
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    const members = (await readFile(path.join(directory, "cgroup.procs"), "utf8")).split(/\s+/).filter(Boolean);
    if (!members.includes(String(pid))) throw new Error("PI_SANDBOX_CGROUP_PROCESS_MISMATCH");
    const cgroup = new FilePiSandboxCgroup(directory);
    await cgroup.apply(limits);
    return cgroup;
  }

  async verifyDestroyed(id: string): Promise<boolean> {
    assertId(id);
    try {
      await access(path.join(this.root, id), constants.F_OK);
      return false;
    } catch {
      return true;
    }
  }
}
