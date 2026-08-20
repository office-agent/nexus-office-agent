import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PiArtifactClassification } from "@/src/modules/pi-agent/domain/workspace-contracts";
import type { PiSupervisorDownloadGrant, PiSupervisorObject, PiWorkspaceSupervisorConfig, PiWorkspaceSupervisorContext, PiWorkspaceSupervisorPersistedGrant } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function validText(value: string, max = 512): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertScope(scope: PiWorkspaceSupervisorContext): void {
  if (![scope.tenantId, scope.actorId, scope.sessionId, scope.runId, scope.traceId].every((value) => validText(value))) throw new Error("PI_OBJECT_STORAGE_SCOPE_INVALID");
}

function sameScope(left: PiWorkspaceSupervisorContext, right: PiWorkspaceSupervisorContext): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionId === right.sessionId && left.runId === right.runId;
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PI_OBJECT_STORAGE_ENDPOINT_INVALID");
  return url;
}

function encodePath(pathname: string): string {
  return pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function storageParts(storageRef: string, bucket: string): { bucket: string; key: string } {
  let url: URL;
  try { url = new URL(storageRef); } catch { throw new Error("PI_OBJECT_STORAGE_REF_INVALID"); }
  if (url.protocol !== "s3:" || url.username || url.password || url.search || url.hash || url.hostname !== bucket || !url.pathname || url.pathname.includes("..")) throw new Error("PI_OBJECT_STORAGE_REF_INVALID");
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key || key.length > 2_000 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("PI_OBJECT_STORAGE_REF_INVALID");
  return { bucket, key };
}

export class S3CompatibleClient {
  private readonly endpoint: URL;

  constructor(private readonly config: Pick<PiWorkspaceSupervisorConfig, "s3Endpoint" | "s3AccessKey" | "s3SecretKey" | "s3Region" | "s3Bucket">) {
    this.endpoint = endpoint(config.s3Endpoint);
    if (!validText(config.s3AccessKey, 256) || !validText(config.s3SecretKey, 2_000) || !validText(config.s3Region, 64) || !validText(config.s3Bucket, 63)) throw new Error("PI_OBJECT_STORAGE_CREDENTIALS_REQUIRED");
  }

  async put(storageRef: string, bytes: Uint8Array, mediaType: string): Promise<string> {
    const parts = storageParts(storageRef, this.config.s3Bucket);
    const response = await this.request("PUT", `/${parts.bucket}/${parts.key}`, Buffer.from(bytes), { "content-type": mediaType });
    if (!response.ok) throw new Error("PI_OBJECT_STORAGE_PUT_FAILED");
    return response.headers.get("etag")?.replace(/^"|"$/g, "") || randomUUID();
  }

  async get(storageRef: string): Promise<Uint8Array> {
    const parts = storageParts(storageRef, this.config.s3Bucket);
    const response = await this.request("GET", `/${parts.bucket}/${parts.key}`);
    if (!response.ok) throw new Error(response.status === 404 ? "PI_OBJECT_NOT_FOUND" : "PI_OBJECT_STORAGE_GET_FAILED");
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(storageRef: string): Promise<void> {
    const parts = storageParts(storageRef, this.config.s3Bucket);
    const response = await this.request("DELETE", `/${parts.bucket}/${parts.key}`);
    if (!response.ok && response.status !== 404) throw new Error("PI_OBJECT_STORAGE_DELETE_FAILED");
  }

  async ensureBucket(): Promise<void> {
    const response = await this.request("PUT", `/${this.config.s3Bucket}`, new Uint8Array(), { "content-type": "application/octet-stream" });
    if (!response.ok && response.status !== 409) throw new Error("PI_OBJECT_STORAGE_BUCKET_NOT_READY");
  }

  private async request(method: string, path: string, body: Uint8Array = new Uint8Array(), extraHeaders: Record<string, string> = {}): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const shortDate = amzDate.slice(0, 8);
    const target = new URL(path.replace(/^\//, ""), this.endpoint);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {
      host: target.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([key, value]) => [key.toLowerCase(), value])),
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((key) => `${key}:${headers[key].trim()}\n`).join("");
    const canonicalRequest = [method, encodePath(target.pathname), canonicalQuery(target), canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
    const scope = `${shortDate}/${this.config.s3Region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${this.config.s3SecretKey}`, shortDate);
    const regionKey = hmac(dateKey, this.config.s3Region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.s3AccessKey}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
    const init: RequestInit = { method, headers: { ...headers, authorization } };
    if (method !== "GET" && method !== "HEAD") init.body = Buffer.from(body);
    return fetch(target, init);
  }
}

export class S3WorkspaceObjectStore {
  private readonly objects = new Map<string, PiSupervisorObject>();
  private readonly grants = new Map<string, PiSupervisorDownloadGrant>();
  private bucketReady?: Promise<void>;
  private readonly client: S3CompatibleClient;

  constructor(private readonly config: PiWorkspaceSupervisorConfig) {
    this.client = new S3CompatibleClient(config);
  }

  async put(input: { scope: PiWorkspaceSupervisorContext; artifactId: string; version: number; bytes: Uint8Array; mediaType: string; classification: PiArtifactClassification }): Promise<{ storageRef: string; objectVersion: string; sizeBytes: number; contentDigest: string }> {
    assertScope(input.scope);
    if (!validText(input.artifactId, 128) || !Number.isInteger(input.version) || input.version <= 0) throw new Error("PI_OBJECT_INPUT_INVALID");
    if (input.bytes.byteLength > 20 * 1024 * 1024) throw new Error("PI_OBJECT_TOO_LARGE");
    const contentDigest = sha256(input.bytes);
    const key = `${input.scope.tenantId}/${input.artifactId}/${input.version}`;
    const storageRef = `s3://${this.config.s3Bucket}/${key}`;
    const existing = this.objects.get(storageRef);
    if (existing) {
      if (!sameScope(existing.scope, input.scope)) throw new Error("PI_OBJECT_SCOPE_MISMATCH");
      if (existing.contentDigest !== contentDigest || existing.sizeBytes !== input.bytes.byteLength || existing.mediaType !== input.mediaType || existing.classification !== input.classification) {
        throw new Error("PI_OBJECT_DUPLICATE");
      }
      return { storageRef: existing.storageRef, objectVersion: existing.objectVersion, sizeBytes: existing.sizeBytes, contentDigest: existing.contentDigest };
    }
    const bucketReady = this.bucketReady ??= this.client.ensureBucket();
    try {
      await bucketReady;
    } catch (error) {
      if (this.bucketReady === bucketReady) this.bucketReady = undefined;
      throw error;
    }
    const objectVersion = await this.client.put(storageRef, input.bytes, input.mediaType);
    const object: PiSupervisorObject = { storageRef, objectVersion, scope: input.scope, artifactId: input.artifactId, version: input.version, sizeBytes: input.bytes.byteLength, contentDigest, mediaType: input.mediaType, classification: input.classification };
    this.objects.set(storageRef, object);
    return { storageRef, objectVersion, sizeBytes: object.sizeBytes, contentDigest };
  }

  async issueGrant(input: { scope: PiWorkspaceSupervisorContext; artifactId: string; version: number; storageRef: string; ttlMs: number }): Promise<{ grantRef: string; url: string; expiresAt: string }> {
    assertScope(input.scope);
    const object = this.objects.get(input.storageRef);
    if (!object || !sameScope(object.scope, input.scope) || object.artifactId !== input.artifactId || object.version !== input.version) throw new Error("PI_OBJECT_NOT_FOUND");
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 15 * 60 * 1000) throw new Error("PI_DOWNLOAD_GRANT_TTL_INVALID");
    const grantRef = `grant-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    this.grants.set(grantRef, { grantRef, object, expiresAt });
    const url = new URL(`/v1/objects/download/${encodeURIComponent(grantRef)}`, this.config.publicBaseUrl).toString();
    return { grantRef, url, expiresAt };
  }

  async revokeGrant(scope: PiWorkspaceSupervisorContext, grantRef: string): Promise<void> {
    assertScope(scope);
    const grant = this.grants.get(grantRef);
    if (!grant || !sameScope(grant.object.scope, scope)) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
    this.grants.delete(grantRef);
  }

  async delete(input: { scope: PiWorkspaceSupervisorContext; artifactId: string; version: number; storageRef: string }): Promise<void> {
    assertScope(input.scope);
    const object = this.objects.get(input.storageRef);
    if (!object || !sameScope(object.scope, input.scope) || object.artifactId !== input.artifactId || object.version !== input.version) throw new Error("PI_OBJECT_NOT_FOUND");
    await this.client.delete(input.storageRef);
    this.objects.delete(input.storageRef);
    for (const [key, grant] of this.grants.entries()) if (grant.object.storageRef === input.storageRef) this.grants.delete(key);
  }

  async download(grantRef: string): Promise<{ object: PiSupervisorObject; bytes: Uint8Array; mediaType: string }> {
    const grant = this.grants.get(grantRef);
    if (!grant) throw new Error("PI_DOWNLOAD_GRANT_NOT_FOUND");
    if (new Date(grant.expiresAt).getTime() <= Date.now()) { this.grants.delete(grantRef); throw new Error("PI_DOWNLOAD_GRANT_EXPIRED"); }
    const bytes = await this.client.get(grant.object.storageRef);
    if (bytes.byteLength !== grant.object.sizeBytes || sha256(bytes) !== grant.object.contentDigest) throw new Error("PI_OBJECT_DIGEST_MISMATCH");
    return { object: grant.object, bytes, mediaType: grant.object.mediaType };
  }

  snapshot(): { objects: PiSupervisorObject[]; grants: PiWorkspaceSupervisorPersistedGrant[] } {
    return {
      objects: [...this.objects.values()].map((object) => ({ ...object, scope: { ...object.scope } })),
      grants: [...this.grants.values()].map((grant) => ({ grantRef: grant.grantRef, storageRef: grant.object.storageRef, expiresAt: grant.expiresAt })),
    };
  }

  restore(input: { objects: PiSupervisorObject[]; grants: PiWorkspaceSupervisorPersistedGrant[] }): void {
    this.objects.clear();
    this.grants.clear();
    for (const object of input.objects) {
      assertScope(object.scope);
      storageParts(object.storageRef, this.config.s3Bucket);
      if (!validText(object.objectVersion, 2_000) || !validText(object.artifactId, 128) || !Number.isInteger(object.version) || object.version <= 0 || !Number.isInteger(object.sizeBytes) || object.sizeBytes < 0 || !/^[a-f0-9]{64}$/i.test(object.contentDigest)) throw new Error("PI_WORKSPACE_STATE_INVALID");
      if (this.objects.has(object.storageRef)) throw new Error("PI_WORKSPACE_STATE_INVALID");
      this.objects.set(object.storageRef, { ...object, scope: { ...object.scope } });
    }
    for (const persistedGrant of input.grants) {
      if (!validText(persistedGrant.grantRef, 2_000) || !persistedGrant.grantRef.startsWith("grant-") || !validText(persistedGrant.storageRef, 2_000) || !validText(persistedGrant.expiresAt, 64) || !Number.isFinite(Date.parse(persistedGrant.expiresAt))) throw new Error("PI_WORKSPACE_STATE_INVALID");
      const object = this.objects.get(persistedGrant.storageRef);
      if (!object || this.grants.has(persistedGrant.grantRef)) throw new Error("PI_WORKSPACE_STATE_INVALID");
      if (new Date(persistedGrant.expiresAt).getTime() <= Date.now()) continue;
      this.grants.set(persistedGrant.grantRef, { grantRef: persistedGrant.grantRef, object, expiresAt: persistedGrant.expiresAt });
    }
  }

  async readiness(): Promise<{ ready: boolean; code?: string }> {
    try {
      this.bucketReady ??= this.client.ensureBucket();
      await this.bucketReady;
      return { ready: true };
    } catch (error) {
      this.bucketReady = undefined;
      return { ready: false, code: error instanceof Error ? error.message : "PI_OBJECT_STORAGE_NOT_READY" };
    }
  }
}
