import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
  PiCompiledEgressPolicy,
  PiSandbox,
  PiSandboxFile,
  PiSandboxResult,
  PiSandboxUsage,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";

const DEFAULT_VSOCK_PORT = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 2_000_000;

export type PiSandboxGuestAgentRequest = {
  version: 1;
  requestId: string;
  operation: "health" | "mountWorkspace" | "read" | "list" | "write" | "patch" | "exec" | "snapshot" | "usage" | "networkPolicy";
  payload?: unknown;
};

export type PiSandboxGuestAgentResponse = {
  version: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string };
};

export interface PiSandboxGuestAgent {
  health(): Promise<void>;
  mountWorkspace(mount: PiWorkspaceMount): Promise<void>;
  applyNetworkPolicy(policy: PiCompiledEgressPolicy): Promise<void>;
  read(path: string): Promise<PiSandboxFile>;
  list(path: string): Promise<string[]>;
  write(path: string, content: string): Promise<PiSandboxFile>;
  applyPatch(path: string, oldText: string, newText: string): Promise<PiSandboxFile>;
  run(command: string, signal?: AbortSignal): Promise<PiSandboxResult>;
  snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }>;
  collectUsage(): Promise<PiSandboxUsage>;
}

export type PiSandboxGuestAgentFactory = (input: {
  sandbox: PiSandbox;
  vsockSocketPath: string;
  guestPort: number;
}) => PiSandboxGuestAgent;

function safeErrorCode(value: unknown): string {
  return value instanceof Error && /^[A-Z0-9_:-]{1,120}$/.test(value.message) ? value.message : "PI_SANDBOX_GUEST_AGENT_FAILED";
}

function assertMessage(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_MESSAGE_BYTES) throw new Error("PI_SANDBOX_GUEST_AGENT_MESSAGE_TOO_LARGE");
}

function assertVsockPath(value: string): void {
  if (!value || !value.startsWith("/") || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("PI_SANDBOX_VSOCK_PATH_INVALID");
}

function assertGuestPort(value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("PI_SANDBOX_GUEST_PORT_INVALID");
}

function parseLine(value: string): PiSandboxGuestAgentResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("PI_SANDBOX_GUEST_AGENT_RESPONSE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PI_SANDBOX_GUEST_AGENT_RESPONSE_INVALID");
  const response = parsed as Partial<PiSandboxGuestAgentResponse>;
  if (response.version !== 1 || typeof response.requestId !== "string" || typeof response.ok !== "boolean") throw new Error("PI_SANDBOX_GUEST_AGENT_RESPONSE_INVALID");
  if (!response.ok && (!response.error || typeof response.error.code !== "string" || !/^[A-Z0-9_:-]{1,120}$/.test(response.error.code))) throw new Error("PI_SANDBOX_GUEST_AGENT_RESPONSE_INVALID");
  return response as PiSandboxGuestAgentResponse;
}

function waitForLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout.id) clearTimeout(timeout.id);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) finish(() => reject(new Error("PI_SANDBOX_GUEST_AGENT_MESSAGE_TOO_LARGE")));
      const index = buffer.indexOf("\n");
      if (index >= 0) finish(() => resolve(buffer.slice(0, index).replace(/\r$/, "")));
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onClose = () => finish(() => reject(new Error("PI_SANDBOX_GUEST_AGENT_CONNECTION_CLOSED")));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    timeout.id = setTimeout(() => finish(() => reject(new Error("PI_SANDBOX_GUEST_AGENT_TIMEOUT"))), timeoutMs);
  });
}

/**
 * Client for the small JSON-lines service shipped inside the approved guest
 * rootfs. The host reaches it only through Firecracker's vsock UDS bridge.
 * The first line is Firecracker's documented CONNECT/OK handshake; all
 * subsequent traffic is one request and one response per connection.
 */
export class VsockPiSandboxGuestAgent implements PiSandboxGuestAgent {
  private readonly socketPath: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connectionFactory: (path: string) => Socket;

  constructor(options: { vsockSocketPath: string; guestPort?: number; timeoutMs?: number; connectionFactory?: (path: string) => Socket }) {
    assertVsockPath(options.vsockSocketPath);
    this.socketPath = options.vsockSocketPath;
    this.port = options.guestPort ?? DEFAULT_VSOCK_PORT;
    assertGuestPort(this.port);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectionFactory = options.connectionFactory ?? ((socketPath) => createConnection({ path: socketPath }));
  }

  private async request<T>(operation: PiSandboxGuestAgentRequest["operation"], payload?: unknown, signal?: AbortSignal): Promise<T> {
    const request: PiSandboxGuestAgentRequest = { version: 1, requestId: randomUUID(), operation, ...(payload === undefined ? {} : { payload }) };
    const encoded = JSON.stringify(request);
    assertMessage(encoded);
    const socket = this.connectionFactory(this.socketPath);
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error("PI_SANDBOX_GUEST_AGENT_TIMEOUT")));
    const abort = () => socket.destroy(new Error("PI_SANDBOX_GUEST_AGENT_ABORTED"));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`CONNECT ${this.port}\n`);
      const acknowledgement = await waitForLine(socket, this.timeoutMs);
      if (!new RegExp(`^OK \\d+$`).test(acknowledgement)) throw new Error("PI_SANDBOX_GUEST_AGENT_VSOCK_HANDSHAKE_INVALID");
      socket.write(`${encoded}\n`);
      const response = parseLine(await waitForLine(socket, this.timeoutMs));
      if (response.requestId !== request.requestId) throw new Error("PI_SANDBOX_GUEST_AGENT_REQUEST_MISMATCH");
      if (!response.ok) throw new Error(response.error?.code ?? "PI_SANDBOX_GUEST_AGENT_FAILED");
      return response.result as T;
    } catch (error) {
      throw new Error(safeErrorCode(error));
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
      socket.destroy();
    }
  }

  async health(): Promise<void> { await this.request("health"); }
  async mountWorkspace(mount: PiWorkspaceMount): Promise<void> { await this.request("mountWorkspace", mount); }
  async applyNetworkPolicy(policy: PiCompiledEgressPolicy): Promise<void> { await this.request("networkPolicy", policy); }
  async read(path: string): Promise<PiSandboxFile> { return this.request("read", { path }); }
  async list(path: string): Promise<string[]> { return this.request("list", { path }); }
  async write(path: string, content: string): Promise<PiSandboxFile> { return this.request("write", { path, content }); }
  async applyPatch(path: string, oldText: string, newText: string): Promise<PiSandboxFile> { return this.request("patch", { path, oldText, newText }); }
  async run(command: string, signal?: AbortSignal): Promise<PiSandboxResult> { return this.request("exec", { command }, signal); }
  async snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return this.request("snapshot"); }
  async collectUsage(): Promise<PiSandboxUsage> { return this.request("usage"); }
}

export function createVsockPiSandboxGuestAgent(input: { sandbox: PiSandbox; vsockSocketPath: string; guestPort?: number }): PiSandboxGuestAgent {
  void input.sandbox;
  return new VsockPiSandboxGuestAgent({ vsockSocketPath: input.vsockSocketPath, guestPort: input.guestPort });
}
