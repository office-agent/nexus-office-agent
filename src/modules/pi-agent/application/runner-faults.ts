import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PI_RUNNER_FAULT_POINTS = [
  "after_claim",
  "before_run_leased_event",
  "after_run_leased_event",
  "before_sandbox_create",
  "after_sandbox_create",
  "before_sandbox_limits",
  "after_sandbox_limits",
  "before_sandbox_network",
  "after_sandbox_network",
  "before_workspace_mount",
  "after_workspace_mount",
  "before_runtime_create",
  "after_runtime_create",
  "before_prompt",
  "during_prompt",
  "before_tool",
  "after_tool",
  "before_event_flush",
  "after_event_flush",
  "before_terminal_commit",
] as const;

export type PiRunnerFaultPoint = (typeof PI_RUNNER_FAULT_POINTS)[number];

export type PiRunnerFaultContext = {
  tenantId: string;
  actorId?: string;
  sessionId: string;
  runId: string;
  commandId?: string;
  eventType?: string;
};

export interface PiRunnerFaultInjector {
  checkpoint(point: PiRunnerFaultPoint, context: PiRunnerFaultContext): Promise<void>;
}

export const noopPiRunnerFaultInjector: PiRunnerFaultInjector = {
  async checkpoint() {},
};

function validPoint(value: string | undefined): PiRunnerFaultPoint | undefined {
  return PI_RUNNER_FAULT_POINTS.includes(value as PiRunnerFaultPoint) ? value as PiRunnerFaultPoint : undefined;
}

function validAction(value: string | undefined): "pause" | "crash" | "throw" | undefined {
  return value === "pause" || value === "crash" || value === "throw" ? value : undefined;
}

function matchesEventFilter(context: PiRunnerFaultContext): boolean {
  const expected = process.env.NEXUS_PI_FAULT_EVENT_TYPE?.trim();
  return !expected || expected === context.eventType;
}

/**
 * Development-only fault controller used by the G-026 process harness.
 * Production refuses to construct it. It is intentionally controlled by
 * process-local environment variables and never accepts a request payload.
 */
export class EnvironmentPiRunnerFaultInjector implements PiRunnerFaultInjector {
  private armed = true;

  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("PI_FAULT_INJECTION_FORBIDDEN");
    if (process.env.NEXUS_PI_FAULT_INJECTION !== "1") throw new Error("PI_FAULT_INJECTION_DISABLED");
    if (!validPoint(process.env.NEXUS_PI_FAULT_POINT) || !validAction(process.env.NEXUS_PI_FAULT_ACTION)) {
      throw new Error("PI_FAULT_INJECTION_CONFIGURATION_INVALID");
    }
  }

  async checkpoint(point: PiRunnerFaultPoint, context: PiRunnerFaultContext): Promise<void> {
    if (!this.armed || validPoint(process.env.NEXUS_PI_FAULT_POINT) !== point || !matchesEventFilter(context)) return;
    this.armed = false;
    const action = validAction(process.env.NEXUS_PI_FAULT_ACTION);
    if (!action) throw new Error("PI_FAULT_INJECTION_CONFIGURATION_INVALID");
    const readyFile = process.env.NEXUS_PI_FAULT_READY_FILE?.trim();
    const releaseFile = process.env.NEXUS_PI_FAULT_RELEASE_FILE?.trim();
    if (readyFile) {
      await mkdir(path.dirname(readyFile), { recursive: true });
      await writeFile(readyFile, JSON.stringify({ point, ...context, pid: process.pid }), "utf8");
    }
    if (action === "throw") throw new Error(`PI_RUN_FAULT_INJECTED:${point}`);
    if (action === "crash") {
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => undefined);
      return;
    }
    if (!releaseFile) throw new Error("PI_FAULT_INJECTION_RELEASE_FILE_REQUIRED");
    const deadline = Date.now() + Math.max(1_000, Number(process.env.NEXUS_PI_FAULT_PAUSE_TIMEOUT_MS ?? 120_000));
    while (Date.now() < deadline) {
      try {
        await access(releaseFile);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("PI_RUN_FAULT_PAUSE_TIMEOUT");
  }
}

export function createPiRunnerFaultInjector(): PiRunnerFaultInjector {
  if (process.env.NODE_ENV === "production" || process.env.NEXUS_PI_FAULT_INJECTION !== "1") return noopPiRunnerFaultInjector;
  return new EnvironmentPiRunnerFaultInjector();
}
