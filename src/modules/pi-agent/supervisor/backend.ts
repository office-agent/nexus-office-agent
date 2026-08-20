import type {
  PiSandbox,
  PiSandboxFile,
  PiSandboxResult,
  PiSandboxUsage,
} from "@/src/modules/pi-agent/domain/contracts";
import type { PiSandboxSupervisorBackend } from "@/src/modules/pi-agent/supervisor/contracts";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { FirecrackerSandboxBackend } from "@/src/modules/pi-agent/supervisor/firecracker-backend";

export class FailClosedPiSandboxSupervisorBackend implements PiSandboxSupervisorBackend {
  readonly kind: "firecracker" | "kata";

  constructor(kind: "firecracker" | "kata", private readonly code = "PI_SANDBOX_SUPERVISOR_BACKEND_UNAVAILABLE") {
    this.kind = kind;
  }

  async readiness(): Promise<{ ready: false; code: string }> { return { ready: false, code: this.code }; }

  private unavailable(): never { throw new Error(this.code); }
  create(): Promise<PiSandbox> { return this.unavailable(); }
  mountWorkspace(): Promise<void> { return this.unavailable(); }
  setLimits(): Promise<void> { return this.unavailable(); }
  applyNetworkPolicy(): Promise<void> { return this.unavailable(); }
  read(): Promise<PiSandboxFile> { return this.unavailable(); }
  list(): Promise<string[]> { return this.unavailable(); }
  write(): Promise<PiSandboxFile> { return this.unavailable(); }
  applyPatch(): Promise<PiSandboxFile> { return this.unavailable(); }
  run(): Promise<PiSandboxResult> { return this.unavailable(); }
  snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return this.unavailable(); }
  collectUsage(): Promise<PiSandboxUsage> { return this.unavailable(); }
  terminate(): Promise<void> { return this.unavailable(); }
  destroy(): Promise<void> { return this.unavailable(); }
  verifyDestroyed(): Promise<boolean> { return this.unavailable(); }
}

export function createPiSandboxSupervisorBackendFromEnv(environment = process.env): PiSandboxSupervisorBackend {
  const provider = environment.NEXUS_PI_SANDBOX_PROVIDER === "kata" ? "kata" : "firecracker";
  if (provider !== "firecracker" || (environment.NEXUS_PI_SANDBOX_SUPERVISOR_BACKEND ?? "firecracker") !== "firecracker") {
    return new FailClosedPiSandboxSupervisorBackend(provider, "PI_SANDBOX_SUPERVISOR_BACKEND_NOT_CONFIGURED");
  }
  const runtimePath = resolveExecutable(environment.NEXUS_PI_FIRECRACKER_PATH ?? "firecracker", environment.PATH);
  const stateDirectory = environment.NEXUS_PI_SANDBOX_STATE_DIR ?? "/var/lib/nexus/pi-sandbox-supervisor";
  const rootfsImage = environment.NEXUS_PI_SANDBOX_ROOTFS;
  const kernelImage = environment.NEXUS_PI_SANDBOX_KERNEL_IMAGE;
  if (!runtimePath || !rootfsImage || !kernelImage) {
    return new FailClosedPiSandboxSupervisorBackend(provider, "PI_SANDBOX_FIRECRACKER_CONFIGURATION_REQUIRED");
  }
  try {
    return new FirecrackerSandboxBackend({
      runtimePath,
      stateDirectory,
      socketDirectory: environment.NEXUS_PI_SANDBOX_SOCKET_DIRECTORY ?? "/run/nexus/pi-sandbox",
      rootfsImage,
      kernelImage,
      guestPort: Number(environment.NEXUS_PI_SANDBOX_GUEST_AGENT_PORT ?? "5000"),
      guestCid: Number(environment.NEXUS_PI_SANDBOX_GUEST_CID ?? "3"),
    });
  } catch {
    return new FailClosedPiSandboxSupervisorBackend(provider, "PI_SANDBOX_FIRECRACKER_CONFIGURATION_INVALID");
  }
}

function resolveExecutable(value: string, pathValue = process.env.PATH): string | undefined {
  if (path.isAbsolute(value)) {
    try { return statSync(value).isFile() ? value : undefined; } catch { return undefined; }
  }
  for (const directory of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, value);
    if (existsSync(candidate)) {
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* continue */ }
    }
  }
  return undefined;
}
