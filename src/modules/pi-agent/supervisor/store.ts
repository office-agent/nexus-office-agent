import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PiSandboxBinding, PiSandboxBindingStore } from "@/src/modules/pi-agent/supervisor/contracts";

function assertSandboxId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("PI_SANDBOX_ID_INVALID");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertBinding(value: PiSandboxBinding): void {
  assertSandboxId(value.sandbox.id);
  if (value.sandbox.provider !== "firecracker" && value.sandbox.provider !== "kata") throw new Error("PI_SANDBOX_BINDING_INVALID");
  if (!value.sandbox.root || !value.sandbox.root.startsWith("/") || value.scope.sandboxId !== undefined) throw new Error("PI_SANDBOX_BINDING_INVALID");
  if (value.sandbox.id !== value.scope.sandboxId && value.scope.sandboxId !== undefined) throw new Error("PI_SANDBOX_BINDING_INVALID");
  if (value.sandbox.provider !== value.scope.provider || value.sandbox.tenantId !== value.scope.tenantId || value.sandbox.actorId !== value.scope.actorId || value.sandbox.sessionId !== value.scope.sessionId || value.sandbox.workspaceId !== value.scope.workspaceId || value.sandbox.runId !== value.scope.runId) throw new Error("PI_SANDBOX_BINDING_SCOPE_INVALID");
  if (!value.createdAt || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("PI_SANDBOX_BINDING_TIMESTAMP_INVALID");
}

export class InMemoryPiSandboxBindingStore implements PiSandboxBindingStore {
  private readonly values = new Map<string, PiSandboxBinding>();

  async initialize(): Promise<void> {}

  async get(sandboxId: string): Promise<PiSandboxBinding | null> {
    assertSandboxId(sandboxId);
    const value = this.values.get(sandboxId);
    return value ? clone(value) : null;
  }

  async put(binding: PiSandboxBinding): Promise<void> {
    assertBinding(binding);
    this.values.set(binding.sandbox.id, clone(binding));
  }

  async delete(sandboxId: string): Promise<void> {
    assertSandboxId(sandboxId);
    this.values.delete(sandboxId);
  }
}

export class FilePiSandboxBindingStore implements PiSandboxBindingStore {
  private initialized = false;

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private file(sandboxId: string): string {
    assertSandboxId(sandboxId);
    return path.join(this.directory, `${sandboxId}.json`);
  }

  async get(sandboxId: string): Promise<PiSandboxBinding | null> {
    await this.ensureInitialized();
    try {
      const text = await readFile(this.file(sandboxId), "utf8");
      const value = JSON.parse(text) as PiSandboxBinding;
      if (!value || value.sandbox?.id !== sandboxId) throw new Error("PI_SANDBOX_BINDING_INVALID");
      assertBinding(value);
      return clone(value);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
      throw new Error("PI_SANDBOX_BINDING_UNAVAILABLE");
    }
  }

  async put(binding: PiSandboxBinding): Promise<void> {
    await this.ensureInitialized();
    assertBinding(binding);
    const target = this.file(binding.sandbox.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(clone(binding)), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async delete(sandboxId: string): Promise<void> {
    await this.ensureInitialized();
    try {
      await rm(this.file(sandboxId), { force: true });
    } catch {
      throw new Error("PI_SANDBOX_BINDING_DELETE_FAILED");
    }
  }
}
