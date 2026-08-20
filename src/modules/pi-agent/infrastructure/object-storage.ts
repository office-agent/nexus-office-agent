import { createHash, randomUUID } from "node:crypto";
import type {
  PiArtifactWriteInput,
  PiObjectStorageScope,
  PiObjectStorageGateway,
} from "@/src/modules/pi-agent/domain/workspace-contracts";
import type { PiWorkspaceContext } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { HttpWorkspaceSupervisorClient, type WorkspaceSupervisorClient } from "@/src/modules/pi-agent/infrastructure/workspace-provider";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertScope(scope: PiObjectStorageScope): void {
  if (![scope.tenantId, scope.actorId, scope.sessionId, scope.runId, scope.traceId].every((value) => typeof value === "string" && value.trim().length > 0)) throw new Error("PI_OBJECT_STORAGE_SCOPE_INVALID");
}

function sameScope(left: PiObjectStorageScope, right: PiObjectStorageScope): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionId === right.sessionId && left.runId === right.runId;
}

function remoteContext(scope: PiObjectStorageScope): PiWorkspaceContext {
  assertScope(scope);
  return {
    ...scope,
    channel: "system",
    roles: ["pi-runner"],
    permissions: [],
    dataScopes: [{ type: "tenant" }],
  };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) throw new Error("PI_DOWNLOAD_GRANT_TTL_INVALID");
}

function assertStorageRef(value: string): void {
  try {
    const url = new URL(value);
    if (!["s3:", "object:", "memory:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || value.length > 2_000) throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
  } catch {
    throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
  }
}

function assertDownloadUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || value.length > 8_000) throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
  } catch {
    throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
  }
}

type MemoryObject = PiArtifactWriteInput & { storageRef: string; objectVersion: string; contentDigest: string };

export class InMemoryPiObjectStorageGateway implements PiObjectStorageGateway {
  private readonly objects = new Map<string, MemoryObject>();
  private readonly grants = new Map<string, PiObjectStorageScope>();

  async put(input: PiArtifactWriteInput): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }> {
    assertScope(input.scope);
    const contentDigest = digest(input.bytes);
    const storageRef = `memory://artifact/${input.scope.tenantId}/${input.artifactId}/${input.version}`;
    const objectVersion = randomUUID();
    this.objects.set(storageRef, { ...input, storageRef, objectVersion, contentDigest });
    return { storageRef, objectVersion, sizeBytes: input.bytes.byteLength, contentDigest };
  }

  async issueDownloadGrant(input: { scope: PiObjectStorageScope; artifactId: string; version: number; storageRef: string; ttlMs: number }): Promise<{ grantRef: string; url: string; expiresAt: string }> {
    assertScope(input.scope);
    assertTtl(input.ttlMs);
    const object = this.objects.get(input.storageRef);
    if (!object || !sameScope(object.scope, input.scope) || object.artifactId !== input.artifactId || object.version !== input.version) throw new Error("PI_OBJECT_NOT_FOUND");
    const grantRef = `memory://grant/${randomUUID()}`;
    this.grants.set(grantRef, { ...input.scope });
    return { grantRef, url: `memory://download/${grantRef.slice("memory://grant/".length)}`, expiresAt: new Date(Date.now() + input.ttlMs).toISOString() };
  }

  async revokeDownloadGrant(input: { scope: PiObjectStorageScope; grantRef: string }): Promise<void> {
    assertScope(input.scope);
    const scope = this.grants.get(input.grantRef);
    if (!scope || !sameScope(scope, input.scope)) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
    this.grants.delete(input.grantRef);
  }

  async deleteObject(input: { scope: PiObjectStorageScope; artifactId: string; version: number; storageRef: string }): Promise<void> {
    assertScope(input.scope);
    const object = this.objects.get(input.storageRef);
    if (object && sameScope(object.scope, input.scope) && object.artifactId === input.artifactId && object.version === input.version) this.objects.delete(input.storageRef);
  }

  getObjectForTest(storageRef: string): MemoryObject | undefined {
    const object = this.objects.get(storageRef);
    return object ? { ...object, bytes: new Uint8Array(object.bytes) } : undefined;
  }
}

export class FailClosedPiObjectStorageGateway implements PiObjectStorageGateway {
  private unavailable(): never { throw new Error("PI_OBJECT_STORAGE_UNAVAILABLE"); }
  put(): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }> { return this.unavailable(); }
  issueDownloadGrant(): Promise<{ grantRef: string; url: string; expiresAt: string }> { return this.unavailable(); }
  revokeDownloadGrant(): Promise<void> { return this.unavailable(); }
  deleteObject(): Promise<void> { return this.unavailable(); }
}

export class HttpPiObjectStorageGateway implements PiObjectStorageGateway {
  constructor(private readonly client: WorkspaceSupervisorClient) {}

  async put(input: PiArtifactWriteInput): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }> {
    const context = remoteContext(input.scope);
    const result = await this.client.request<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }>("/v1/objects/put", {
      artifactId: input.artifactId,
      version: input.version,
      bytesBase64: Buffer.from(input.bytes).toString("base64"),
      mediaType: input.mediaType,
      classification: input.classification,
    }, context);
    if (!result.storageRef || !result.objectVersion || !/^[a-f0-9]{64}$/i.test(result.contentDigest) || !Number.isInteger(result.sizeBytes) || result.sizeBytes !== input.bytes.byteLength || result.contentDigest.toLowerCase() !== digest(input.bytes)) throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
    assertStorageRef(result.storageRef);
    return result;
  }

  async issueDownloadGrant(input: { scope: PiObjectStorageScope; artifactId: string; version: number; storageRef: string; ttlMs: number }): Promise<{ grantRef: string; url: string; expiresAt: string }> {
    const context = remoteContext(input.scope);
    assertStorageRef(input.storageRef);
    assertTtl(input.ttlMs);
    const result = await this.client.request<{ grantRef: string; url: string; expiresAt: string }>("/v1/objects/download-grant", {
      artifactId: input.artifactId,
      version: input.version,
      storageRef: input.storageRef,
      ttlMs: input.ttlMs,
    }, context);
    if (!result.grantRef || !result.url || !result.expiresAt || /[\u0000-\u001f\u007f]/.test(result.grantRef)) throw new Error("PI_OBJECT_STORAGE_RESPONSE_INVALID");
    assertDownloadUrl(result.url);
    return result;
  }

  async revokeDownloadGrant(input: { scope: PiObjectStorageScope; grantRef: string }): Promise<void> {
    const context = remoteContext(input.scope);
    if (!input.grantRef.trim() || /[\u0000-\u001f\u007f]/.test(input.grantRef)) throw new Error("PI_OBJECT_STORAGE_SCOPE_INVALID");
    await this.client.request("/v1/objects/download-grant/revoke", { grantRef: input.grantRef }, context);
  }

  async deleteObject(input: { scope: PiObjectStorageScope; artifactId: string; version: number; storageRef: string }): Promise<void> {
    const context = remoteContext(input.scope);
    assertStorageRef(input.storageRef);
    await this.client.request("/v1/objects/delete", { artifactId: input.artifactId, version: input.version, storageRef: input.storageRef }, context);
  }
}

export function createPiObjectStorageGateway(): PiObjectStorageGateway {
  if (process.env.NEXUS_PI_OBJECT_STORAGE_PROVIDER === "memory" && process.env.NODE_ENV !== "production") return new InMemoryPiObjectStorageGateway();
  const endpoint = process.env.NEXUS_PI_OBJECT_STORAGE_ENDPOINT;
  if (endpoint) {
    try { return new HttpPiObjectStorageGateway(new HttpWorkspaceSupervisorClient(endpoint)); } catch { return new FailClosedPiObjectStorageGateway(); }
  }
  return new FailClosedPiObjectStorageGateway();
}
