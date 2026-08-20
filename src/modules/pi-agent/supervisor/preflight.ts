import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";

export type PiSandboxPreflightStatus = "pass" | "fail" | "unknown";

export type PiSandboxPreflightCheck = {
  id: string;
  required: boolean;
  status: PiSandboxPreflightStatus;
  detail: string;
};

export type PiSandboxPreflightResult = {
  schemaVersion: 1;
  provider: "firecracker" | "kata" | "unknown";
  status: "ready" | "not_ready";
  checks: PiSandboxPreflightCheck[];
};

type PreflightEnvironment = Record<string, string | undefined>;

type PreflightDependencies = {
  platform?: NodeJS.Platform;
  arch?: string;
  access?: (file: string, mode?: number) => Promise<void>;
  readFile?: (file: string, encoding: BufferEncoding) => Promise<string>;
  resolveExecutable?: (name: string) => Promise<string | null>;
  isFile?: (file: string) => Promise<boolean>;
};

const defaultDependencies: Required<PreflightDependencies> = {
  platform: process.platform,
  arch: process.arch,
  access,
  readFile: async (file, encoding) => readFile(file, encoding),
  resolveExecutable: async (name) => {
    const pathValue = process.env.PATH ?? "";
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching without exposing filesystem errors in the report.
      }
    }
    return null;
  },
  isFile: async (file) => {
    try {
      const stat = await import("node:fs/promises").then(({ stat }) => stat(file));
      return stat.isFile();
    } catch {
      return false;
    }
  },
};

function check(id: string, required: boolean, status: PiSandboxPreflightStatus, detail: string): PiSandboxPreflightCheck {
  return { id, required, status, detail: detail.slice(0, 240) };
}

function requiredPass(checks: PiSandboxPreflightCheck[]): boolean {
  return checks.every((item) => !item.required || item.status === "pass");
}

function parseProvider(value: string | undefined): "firecracker" | "kata" | "unknown" {
  return value === "firecracker" || value === "kata" ? value : "unknown";
}

function validHttpsEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export async function collectPiSandboxPreflight(
  environment: PreflightEnvironment = process.env,
  dependencies: PreflightDependencies = {},
): Promise<PiSandboxPreflightResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const provider = parseProvider(environment.NEXUS_PI_SANDBOX_PROVIDER);
  const checks: PiSandboxPreflightCheck[] = [];

  checks.push(deps.platform === "linux"
    ? check("platform-linux", true, "pass", "Linux host detected")
    : check("platform-linux", true, "fail", "Firecracker/Kata supervisor requires Linux"));
  checks.push(deps.arch === "x64" || deps.arch === "arm64"
    ? check("architecture", true, "pass", `supported architecture: ${deps.arch}`)
    : check("architecture", true, "fail", `unsupported architecture: ${deps.arch}`));
  checks.push(provider === "unknown"
    ? check("provider-configured", true, "fail", "NEXUS_PI_SANDBOX_PROVIDER must be firecracker or kata")
    : check("provider-configured", true, "pass", `provider=${provider}`));

  const kvm = await deps.access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => true).catch(() => false);
  checks.push(kvm
    ? check("kvm-device", true, "pass", "/dev/kvm is readable and writable")
    : check("kvm-device", true, "fail", "/dev/kvm is unavailable or inaccessible"));
  const vsock = await deps.access("/dev/vhost-vsock", constants.R_OK | constants.W_OK).then(() => true).catch(() => false);
  checks.push(vsock
    ? check("vsock-device", true, "pass", "/dev/vhost-vsock is readable and writable")
    : check("vsock-device", true, "fail", "/dev/vhost-vsock is unavailable or inaccessible"));

  const cgroupControllers = await deps.readFile("/sys/fs/cgroup/cgroup.controllers", "utf8").catch(() => "");
  const controllerSet = new Set(cgroupControllers.split(/\s+/).filter(Boolean));
  const missingControllers = ["cpu", "memory", "pids"].filter((item) => !controllerSet.has(item));
  checks.push(cgroupControllers
    ? check("cgroup-v2", true, "pass", "cgroup v2 controllers file is readable")
    : check("cgroup-v2", true, "fail", "cgroup v2 controllers file is unavailable"));
  checks.push(missingControllers.length === 0
    ? check("cgroup-controls", true, "pass", "cpu/memory/pids controllers are available")
    : check("cgroup-controls", true, "fail", `missing controllers: ${missingControllers.join(",")}`));

  const runtimeName = provider === "kata" ? "kata-runtime" : "firecracker";
  const runtimePath = provider === "unknown" ? null : await deps.resolveExecutable(runtimeName);
  checks.push(provider === "unknown"
    ? check("runtime-binary", true, "unknown", "provider is not configured")
    : runtimePath
      ? check("runtime-binary", true, "pass", `${runtimeName} is available`)
      : check("runtime-binary", true, "fail", `${runtimeName} is not available on PATH`));

  const rootfs = environment.NEXUS_PI_SANDBOX_ROOTFS;
  const rootfsReady = Boolean(rootfs) && await deps.isFile(rootfs!);
  checks.push(rootfsReady
    ? check("rootfs-image", true, "pass", "sandbox rootfs image is available")
    : check("rootfs-image", true, "fail", "NEXUS_PI_SANDBOX_ROOTFS must point to a prepared rootfs image file"));

  const kernel = environment.NEXUS_PI_SANDBOX_KERNEL_IMAGE;
  const kernelReady = Boolean(kernel) && await deps.isFile(kernel!);
  checks.push(kernelReady
    ? check("kernel-image", true, "pass", "sandbox kernel image is available")
    : check("kernel-image", true, "fail", "NEXUS_PI_SANDBOX_KERNEL_IMAGE must point to a prepared kernel image file"));

  const guestPort = Number(environment.NEXUS_PI_SANDBOX_GUEST_AGENT_PORT ?? "5000");
  checks.push(Number.isInteger(guestPort) && guestPort >= 1024 && guestPort <= 65535
    ? check("guest-agent-port", true, "pass", `Guest Agent vsock port=${guestPort}`)
    : check("guest-agent-port", true, "fail", "NEXUS_PI_SANDBOX_GUEST_AGENT_PORT must be an integer between 1024 and 65535"));

  const endpoint = environment.NEXUS_PI_SANDBOX_ENDPOINT;
  checks.push(validHttpsEndpoint(endpoint)
    ? check("supervisor-endpoint", true, "pass", "Supervisor endpoint uses HTTPS without embedded credentials")
    : check("supervisor-endpoint", true, "fail", "NEXUS_PI_SANDBOX_ENDPOINT must be an HTTPS URL without credentials/query/hash"));

  const secretLength = Buffer.byteLength(environment.NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET ?? "", "utf8");
  checks.push(secretLength >= 32
    ? check("run-token-secret", true, "pass", "managed Run Token secret meets minimum length")
    : check("run-token-secret", true, "fail", "managed Run Token secret is missing or shorter than 32 bytes"));

  const egressProxy = environment.NEXUS_PI_EGRESS_PROXY_ENDPOINT;
  checks.push(egressProxy === undefined || validHttpsEndpoint(egressProxy)
    ? check("egress-proxy", false, "pass", egressProxy ? "egress proxy endpoint is HTTPS" : "no egress proxy configured; default deny remains required")
    : check("egress-proxy", false, "fail", "egress proxy endpoint must be HTTPS without credentials/query/hash"));

  return { schemaVersion: 1, provider, status: requiredPass(checks) ? "ready" : "not_ready", checks };
}
