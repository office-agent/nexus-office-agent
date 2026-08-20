import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiWorkspaceSupervisorState } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_KEY = /(?:token|secret|password|authorization|private.?key)/i;

function text(value: unknown, max = 2_000): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("PI_WORKSPACE_STATE_INVALID");
}

function scope(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PI_WORKSPACE_STATE_INVALID");
  const item = value as Record<string, unknown>;
  for (const key of ["tenantId", "actorId", "sessionId", "runId", "traceId"]) text(item[key], 512);
}

function noSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) noSecrets(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error("PI_WORKSPACE_STATE_SECRET_FORBIDDEN");
    noSecrets(item);
  }
}

function iso(value: unknown): void {
  text(value, 64);
  if (!Number.isFinite(Date.parse(value))) throw new Error("PI_WORKSPACE_STATE_INVALID");
}

export function validatePiWorkspaceSupervisorState(value: unknown): PiWorkspaceSupervisorState {
  noSecrets(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PI_WORKSPACE_STATE_INVALID");
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.leases) || !Array.isArray(state.workspaces) || !Array.isArray(state.objects) || !Array.isArray(state.grants)) throw new Error("PI_WORKSPACE_STATE_INVALID");

  for (const item of state.leases) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("PI_WORKSPACE_STATE_INVALID");
    const lease = item as Record<string, unknown>;
    text(lease.leaseRef, 2_000);
    if (!String(lease.leaseRef).startsWith("openbao://lease/")) throw new Error("PI_WORKSPACE_STATE_INVALID");
    scope(lease.scope);
    for (const key of ["repositoryId", "repositoryRef", "workspaceId", "branch"]) text(lease[key], 2_000);
    iso(lease.expiresAt);
  }

  for (const item of state.workspaces) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("PI_WORKSPACE_STATE_INVALID");
    const workspace = item as Record<string, unknown>;
    for (const key of ["id", "workspaceId", "providerWorkspaceRef", "directory", "baseRef", "baseCommitSha"]) text(workspace[key], 4_000);
    if (!String(workspace.providerWorkspaceRef).startsWith("forgejo://workspace/")) throw new Error("PI_WORKSPACE_STATE_INVALID");
    scope(workspace.context);
    if (!workspace.repository || typeof workspace.repository !== "object" || Array.isArray(workspace.repository)) throw new Error("PI_WORKSPACE_STATE_INVALID");
    const repository = workspace.repository as Record<string, unknown>;
    for (const key of ["id", "tenantId", "workspaceId", "provider", "repositoryRef", "defaultBranch", "credentialRef", "status", "createdAt"]) text(repository[key], 2_000);
    iso(repository.createdAt);
    if (workspace.branch !== undefined) text(workspace.branch, 512);
    if (workspace.headCommitSha !== undefined) text(workspace.headCommitSha, 128);
  }

  for (const item of state.objects) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("PI_WORKSPACE_STATE_INVALID");
    const object = item as Record<string, unknown>;
    for (const key of ["storageRef", "objectVersion", "artifactId", "contentDigest", "mediaType", "classification"]) text(object[key], 2_000);
    scope(object.scope);
    if (!Number.isInteger(object.version) || Number(object.version) <= 0 || !Number.isInteger(object.sizeBytes) || Number(object.sizeBytes) < 0) throw new Error("PI_WORKSPACE_STATE_INVALID");
    if (!/^s3:\/\/[^/]+\/.+/.test(String(object.storageRef)) || !/^[a-f0-9]{64}$/i.test(String(object.contentDigest))) throw new Error("PI_WORKSPACE_STATE_INVALID");
  }

  for (const item of state.grants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("PI_WORKSPACE_STATE_INVALID");
    const grant = item as Record<string, unknown>;
    for (const key of ["grantRef", "storageRef"]) text(grant[key], 2_000);
    iso(grant.expiresAt);
  }

  return state as unknown as PiWorkspaceSupervisorState;
}

function clone(state: PiWorkspaceSupervisorState): PiWorkspaceSupervisorState {
  return JSON.parse(JSON.stringify(state)) as PiWorkspaceSupervisorState;
}

export function emptyPiWorkspaceSupervisorState(): PiWorkspaceSupervisorState {
  return { schemaVersion: SCHEMA_VERSION, leases: [], workspaces: [], objects: [], grants: [] };
}

export type PiWorkspaceSupervisorStateStoreSaveOptions = {
  /**
   * Persist only the tenant slices affected by the current mutation. A
   * database-backed implementation uses this to avoid a stale process
   * overwriting another tenant's newer state.
   */
  tenantIds?: readonly string[];
};

export interface PiWorkspaceSupervisorStateStore {
  load(): Promise<PiWorkspaceSupervisorState>;
  save(state: PiWorkspaceSupervisorState, options?: PiWorkspaceSupervisorStateStoreSaveOptions): Promise<void>;
  renew?(): Promise<void>;
  release?(): Promise<void>;
}

export class InMemoryPiWorkspaceSupervisorStateStore implements PiWorkspaceSupervisorStateStore {
  private state = emptyPiWorkspaceSupervisorState();

  async load(): Promise<PiWorkspaceSupervisorState> {
    return clone(this.state);
  }

  async save(state: PiWorkspaceSupervisorState): Promise<void> {
    this.state = clone(validatePiWorkspaceSupervisorState(state));
  }
}

export class JsonFilePiWorkspaceSupervisorStateStore implements PiWorkspaceSupervisorStateStore {
  constructor(private readonly filePath: string) {
    text(filePath, 4_000);
  }

  async load(): Promise<PiWorkspaceSupervisorState> {
    try {
      const data = await readFile(this.filePath);
      if (data.byteLength > MAX_STATE_BYTES) throw new Error("PI_WORKSPACE_STATE_TOO_LARGE");
      return clone(validatePiWorkspaceSupervisorState(JSON.parse(data.toString("utf8"))));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return emptyPiWorkspaceSupervisorState();
      if (error instanceof Error && error.message.startsWith("PI_WORKSPACE_STATE_")) throw error;
      throw new Error("PI_WORKSPACE_STATE_INVALID");
    }
  }

  async save(state: PiWorkspaceSupervisorState): Promise<void> {
    const validated = validatePiWorkspaceSupervisorState(state);
    const payload = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) throw new Error("PI_WORKSPACE_STATE_TOO_LARGE");
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      throw new Error(error instanceof Error && error.message.startsWith("PI_WORKSPACE_STATE_") ? error.message : "PI_WORKSPACE_STATE_PERSIST_FAILED");
    }
  }
}
