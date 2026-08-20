// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { Duplex, type DuplexOptions } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { VsockPiSandboxGuestAgent } from "@/src/modules/pi-agent/supervisor/guest-agent";

class LoopbackGuestSocket extends Duplex {
  private buffer = "";
  readonly lines: string[] = [];

  constructor(options?: DuplexOptions) {
    super(options);
    queueMicrotask(() => this.emit("connect"));
  }

  _read(): void {}

  setTimeout(timeout: number, callback?: () => void): this { void timeout; void callback; return this; }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.lines.push(line);
      if (line.startsWith("CONNECT ")) {
        this.push(`OK ${line.slice("CONNECT ".length)}\n`);
      } else {
        const request = JSON.parse(line) as { requestId: string };
        this.push(`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: { path: "src/index.ts", content: "ok", digest: "digest" } })}\n`);
      }
      newline = this.buffer.indexOf("\n");
    }
    callback();
  }
}

function createAgent(factory: (socket: LoopbackGuestSocket) => void): VsockPiSandboxGuestAgent {
  return new VsockPiSandboxGuestAgent({
    vsockSocketPath: "/run/nexus/vsock.sock",
    guestPort: 5000,
    timeoutMs: 1_000,
    connectionFactory: () => {
      const socket = new LoopbackGuestSocket();
      factory(socket);
      return socket as unknown as Socket;
    },
  });
}

describe("VsockPiSandboxGuestAgent", () => {
  it("performs the CONNECT/OK handshake and validates the correlated JSONL response", async () => {
    let socket: LoopbackGuestSocket | undefined;
    const agent = createAgent((value) => { socket = value; });
    await expect(agent.read("src/index.ts")).resolves.toMatchObject({ path: "src/index.ts", content: "ok" });
    expect(socket?.lines[0]).toBe("CONNECT 5000");
    const request = JSON.parse(socket?.lines[1] ?? "{}") as { version: number; requestId: string; operation: string; payload: { path: string } };
    expect(request).toMatchObject({ version: 1, operation: "read", payload: { path: "src/index.ts" } });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("fails closed on an invalid vsock acknowledgement", async () => {
    const agent = new VsockPiSandboxGuestAgent({
      vsockSocketPath: "/run/nexus/vsock.sock",
      connectionFactory: () => {
        class InvalidSocket extends LoopbackGuestSocket {
          override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            if ((Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).startsWith("CONNECT ")) this.push("BAD\n");
            callback();
          }
        }
        return new InvalidSocket() as unknown as Socket;
      },
    });
    await expect(agent.health()).rejects.toThrow("PI_SANDBOX_GUEST_AGENT_VSOCK_HANDSHAKE_INVALID");
  });
});
