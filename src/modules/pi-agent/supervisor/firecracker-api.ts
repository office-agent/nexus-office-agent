import { request as httpRequest, type IncomingMessage } from "node:http";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export type FirecrackerApiMethod = "GET" | "PUT" | "PATCH" | "DELETE";

export type FirecrackerApiRequest = {
  method: FirecrackerApiMethod;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type FirecrackerApiResponse = {
  status: number;
  body?: unknown;
};

export interface FirecrackerApiTransport {
  request(input: FirecrackerApiRequest): Promise<FirecrackerApiResponse>;
}

export class FirecrackerApiError extends Error {
  constructor(readonly status: number, readonly path: string, readonly responseBody?: unknown) {
    super(`PI_FIRECRACKER_API_HTTP_${status}`);
  }
}

function assertUnixSocketPath(value: string): void {
  if (!value || !value.startsWith("/") || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("PI_FIRECRACKER_API_SOCKET_PATH_INVALID");
  }
}

function assertApiPath(value: string): void {
  if (!value.startsWith("/") || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || value.includes("..")) {
    throw new Error("PI_FIRECRACKER_API_PATH_INVALID");
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("PI_FIRECRACKER_API_RESPONSE_INVALID");
  }
}

function responseChunk(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function abortError(): Error {
  return new Error("PI_FIRECRACKER_API_ABORTED");
}

/**
 * Firecracker exposes its control API over a Unix Domain Socket. This
 * transport intentionally has no TCP fallback: a TCP endpoint would make a
 * host-level control API reachable from an unexpected network namespace.
 */
export class UnixSocketFirecrackerApiTransport implements FirecrackerApiTransport {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(socketPath: string, options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
    assertUnixSocketPath(socketPath);
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  request(input: FirecrackerApiRequest): Promise<FirecrackerApiResponse> {
    assertApiPath(input.path);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;

    return new Promise<FirecrackerApiResponse>((resolve, reject) => {
      let settled = false;
      let total = 0;
      const chunks: Buffer[] = [];
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const request = httpRequest({
        socketPath: this.socketPath,
        path: input.path,
        method: input.method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          }),
        },
      }, (response: IncomingMessage) => {
        response.on("data", (chunk: Buffer | string) => {
          const buffer = responseChunk(chunk);
          total += buffer.length;
          if (total > this.maxResponseBytes) {
            request.destroy(new Error("PI_FIRECRACKER_API_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          finish(() => {
            try {
              resolve({ status: response.statusCode ?? 0, body: parseResponseBody(Buffer.concat(chunks).toString("utf8")) });
            } catch (error) {
              reject(error);
            }
          });
        });
        response.on("error", (error) => finish(() => reject(error)));
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("PI_FIRECRACKER_API_TIMEOUT")));
      request.on("error", (error) => finish(() => reject(error)));
      if (input.signal) {
        if (input.signal.aborted) {
          request.destroy(abortError());
        } else {
          input.signal.addEventListener("abort", () => request.destroy(abortError()), { once: true });
        }
      }
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

export type FirecrackerMachineConfig = {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean;
  track_dirty_pages?: boolean;
};

export type FirecrackerBootSource = {
  kernel_image_path: string;
  boot_args: string;
  initrd_image_path?: string;
};

export type FirecrackerDrive = {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
};

export type FirecrackerVsock = {
  vsock_id: string;
  guest_cid: number;
  uds_path: string;
};

export type FirecrackerConfiguration = {
  machineConfig: FirecrackerMachineConfig;
  bootSource: FirecrackerBootSource;
  rootfs: FirecrackerDrive;
  vsock: FirecrackerVsock;
};

export class FirecrackerApiClient {
  constructor(private readonly transport: FirecrackerApiTransport) {}

  private async put(path: string, body: unknown): Promise<void> {
    const response = await this.transport.request({ method: "PUT", path, body });
    if (response.status < 200 || response.status >= 300) throw new FirecrackerApiError(response.status, path, response.body);
  }

  async configure(configuration: FirecrackerConfiguration): Promise<void> {
    await this.put("/machine-config", configuration.machineConfig);
    await this.put("/boot-source", configuration.bootSource);
    await this.put(`/drives/${configuration.rootfs.drive_id}`, configuration.rootfs);
    await this.put("/vsock", configuration.vsock);
  }

  async start(): Promise<void> {
    await this.put("/actions", { action_type: "InstanceStart" });
  }

  async sendCtrlAltDel(): Promise<void> {
    await this.put("/actions", { action_type: "SendCtrlAltDel" });
  }

  async getVm(): Promise<unknown> {
    const response = await this.transport.request({ method: "GET", path: "/vm" });
    if (response.status < 200 || response.status >= 300) throw new FirecrackerApiError(response.status, "/vm", response.body);
    return response.body;
  }
}
