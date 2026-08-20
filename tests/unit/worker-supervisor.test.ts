// Requirements: AR-009, AR-010, AC-006, DR-013, DR-014
import { describe, expect, it, vi } from "vitest";
import { WorkerSupervisor, type TenantWorker } from "@/src/platform/workers/supervisor";

describe("Worker supervisor", () => {
  it("rotates the first-served tenant between cycles and enforces the per-role budget", async () => {
    const handled: string[] = [];
    const worker: TenantWorker = {
      role: "inbox",
      async processTenant(tenantId) {
        handled.push(tenantId);
        return { role: "inbox", status: "succeeded", workId: tenantId };
      },
    };
    const supervisor = new WorkerSupervisor(
      { async listActiveTenantIds() { return ["tenant-a","tenant-b","tenant-c"]; } },
      { async beat() {} },
      [worker],
      { instanceId: "worker-fair", releaseVersion: "0.12.0", maxItemsPerRolePerCycle: 1 },
    );
    await supervisor.processCycle(new Date("2026-08-05T00:00:00.000Z"));
    await supervisor.processCycle(new Date("2026-08-05T00:00:01.000Z"));
    await supervisor.processCycle(new Date("2026-08-05T00:00:02.000Z"));
    expect(handled).toEqual(["tenant-a","tenant-b","tenant-c"]);
  });

  it("marks every enabled role as draining during graceful shutdown", async () => {
    const beats: Array<{ role: string; draining?: boolean }> = [];
    const workers: TenantWorker[] = ["inbox","agent","outbox"].map((role) => ({
      role: role as TenantWorker["role"],
      async processTenant() { return { role: role as TenantWorker["role"], status: "idle" }; },
    }));
    const supervisor = new WorkerSupervisor(
      { async listActiveTenantIds() { return []; } },
      { async beat(input) { beats.push({ role: input.role, draining: input.draining }); } },
      workers,
      { instanceId: "worker-drain", releaseVersion: "0.12.0" },
    );
    const controller = new AbortController();
    controller.abort();
    await supervisor.run(controller.signal);
    expect(beats).toEqual([
      { role: "inbox", draining: true },
      { role: "agent", draining: true },
      { role: "outbox", draining: true },
    ]);
  });

  it("stops leasing new tenants after shutdown while allowing the active tenant to reach a safe point", async () => {
    const controller = new AbortController();
    const handled: string[] = [];
    const supervisor = new WorkerSupervisor(
      { async listActiveTenantIds() { return ["tenant-a","tenant-b","tenant-c"]; } },
      { async beat() {} },
      [{
        role: "inbox",
        async processTenant(tenantId) {
          handled.push(tenantId);
          controller.abort();
          return { role: "inbox", status: "succeeded", workId: tenantId };
        },
      }],
      { instanceId: "worker-safe-point", releaseVersion: "0.12.0" },
    );
    await supervisor.processCycle(new Date("2026-08-05T00:00:00.000Z"), controller.signal);
    expect(handled).toEqual(["tenant-a"]);
  });

  it("begins draining immediately when SIGTERM-style abort arrives during a detached claim", async () => {
    const controller = new AbortController();
    const claims: string[] = [];
    let draining = false;
    let releaseClaim!: () => void;
    const claimSettled = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const supervisor = new WorkerSupervisor(
      { async listActiveTenantIds() { return ["tenant-a", "tenant-b"]; } },
      { async beat() {} },
      [{
        role: "pi-runner",
        beginDrain() { draining = true; },
        async processTenant(tenantId) {
          return { role: "pi-runner", status: "idle", workId: tenantId };
        },
        async processTenantDetached(tenantId) {
          if (draining) throw new Error("CLAIM_AFTER_DRAIN");
          claims.push(tenantId);
          controller.abort();
          await claimSettled;
          return { role: "pi-runner", status: "running", workId: tenantId };
        },
        async drain() { releaseClaim(); },
      }],
      { instanceId: "runner-immediate-drain", releaseVersion: "0.15.0", pollIntervalMs: 10 },
    );

    await supervisor.run(controller.signal);

    expect(claims).toEqual(["tenant-a"]);
    expect(draining).toBe(true);
  });

  it("isolates an infrastructure failure to one role and still serves the remaining roles", async () => {
    const calls: string[] = [];
    const workers: TenantWorker[] = [
      {
        role: "inbox",
        async processTenant(tenantId) { calls.push(`inbox:${tenantId}`); throw new Error("DATABASE_TEMPORARILY_UNAVAILABLE"); },
      },
      {
        role: "outbox",
        async processTenant(tenantId) { calls.push(`outbox:${tenantId}`); return { role: "outbox", status: "succeeded", workId: tenantId }; },
      },
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const supervisor = new WorkerSupervisor(
        { async listActiveTenantIds() { return ["tenant-a","tenant-b"]; } },
        { async beat() {} },
        workers,
        { instanceId: "worker-isolation", releaseVersion: "0.12.0", maxItemsPerRolePerCycle: 1 },
      );
      expect(await supervisor.processCycle(new Date("2026-08-05T00:00:00.000Z"))).toEqual([
        { role: "inbox", status: "failed" },
        { role: "outbox", status: "succeeded", workId: "tenant-a" },
      ]);
      expect(calls).toEqual(["inbox:tenant-a", "outbox:tenant-a"]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps polling after a transient tenant-directory failure", async () => {
    const controller = new AbortController();
    let directoryCalls = 0;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const supervisor = new WorkerSupervisor(
        {
          async listActiveTenantIds() {
            directoryCalls += 1;
            if (directoryCalls === 1) throw new Error("DATABASE_TEMPORARILY_UNAVAILABLE");
            controller.abort();
            return [];
          },
        },
        { async beat() {} },
        [{ role: "agent", async processTenant() { return { role: "agent", status: "idle" }; } }],
        { instanceId: "worker-recovery", releaseVersion: "0.12.0", pollIntervalMs: 50 },
      );
      await supervisor.run(controller.signal);
      expect(directoryCalls).toBe(2);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps the Runner heartbeat loop alive while a detached claim is running", async () => {
    const controller = new AbortController();
    const beats: Array<{ draining?: boolean }> = [];
    let detachedClaims = 0;
    const supervisor = new WorkerSupervisor(
      { async listActiveTenantIds() { return ["tenant-a"]; } },
      { async beat(input) { beats.push({ draining: input.draining }); } },
      [{
        role: "pi-runner",
        async processTenant() { return { role: "pi-runner", status: "succeeded" }; },
        async processTenantDetached() {
          detachedClaims += 1;
          return { role: "pi-runner", status: "running", workId: `run-${detachedClaims}` };
        },
      }],
      { instanceId: "runner-heartbeat", releaseVersion: "0.15.0", pollIntervalMs: 10, heartbeatIntervalMs: 1_000 },
    );
    setTimeout(() => controller.abort(), 2_200);
    await supervisor.run(controller.signal);

    expect(detachedClaims).toBeGreaterThan(1);
    expect(beats.filter((beat) => !beat.draining).length).toBeGreaterThanOrEqual(2);
    expect(beats.at(-1)?.draining).toBe(true);
  });
});
