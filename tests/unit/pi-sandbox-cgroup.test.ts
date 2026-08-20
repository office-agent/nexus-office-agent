// Requirements: PR-009, SR-003, AC-006, AC-010, DR-009
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PiSandboxLimits } from "@/src/modules/pi-agent/domain/contracts";
import { FilePiSandboxCgroupController } from "@/src/modules/pi-agent/supervisor/cgroup";

const limits: PiSandboxLimits = {
  cpuMillis: 1_000,
  memoryBytes: 64 * 1024 * 1024,
  pids: 32,
  diskBytes: 64 * 1024 * 1024,
  maxDurationMs: 30_000,
  maxOutputBytes: 10_000,
};

describe("FilePiSandboxCgroupController", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
  });

  async function prepareCgroup(processes: string): Promise<{ root: string; directory: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "pi-cgroup-"));
    directories.push(root);
    const directory = path.join(root, "sandbox-a");
    await mkdir(directory);
    await writeFile(path.join(directory, "cgroup.procs"), processes, "utf8");
    return { root, directory };
  }

  it("reopens only when the persisted VMM PID is in cgroup.procs", async () => {
    const { root } = await prepareCgroup("4242\n");
    const controller = new FilePiSandboxCgroupController(root);
    await expect(controller.open!("sandbox-a", limits, 4242)).resolves.toBeDefined();
    await expect(controller.open!("sandbox-a", limits, 4343)).rejects.toThrow("PI_SANDBOX_CGROUP_PROCESS_MISMATCH");
  });

  it("does not accept an invalid persisted PID for recovery", async () => {
    const { root } = await prepareCgroup("4242\n");
    const controller = new FilePiSandboxCgroupController(root);
    await expect(controller.open!("sandbox-a", limits, 0)).rejects.toThrow("PI_SANDBOX_PROCESS_PID_INVALID");
  });

  it("reports a cgroup residual until its directory is gone", async () => {
    const { root, directory } = await prepareCgroup("4242\n");
    const controller = new FilePiSandboxCgroupController(root);
    await expect(controller.verifyDestroyed!("sandbox-a")).resolves.toBe(false);
    await rm(directory, { recursive: true, force: true });
    await expect(controller.verifyDestroyed!("sandbox-a")).resolves.toBe(true);
  });
});
