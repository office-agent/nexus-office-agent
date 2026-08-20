// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PiArtifactClassification } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { S3WorkspaceObjectStore } from "@/src/modules/pi-agent/workspace-supervisor/s3-object-store";
import type { PiWorkspaceSupervisorConfig, PiWorkspaceSupervisorContext } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

type FakeObjectStore = {
  server: Server;
  endpoint: string;
  objects: Map<string, Uint8Array>;
  objectPutCount: () => number;
};

const servers: Server[] = [];

async function startFakeObjectStore(): Promise<FakeObjectStore> {
  const objects = new Map<string, Uint8Array>();
  let objectPutCount = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (request.method === "PUT" && pathname === "/pi-artifacts") {
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.method === "PUT") {
        objectPutCount += 1;
        objects.set(pathname, bytes);
        response.statusCode = 200;
        response.setHeader("etag", `"etag-${objectPutCount}"`);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const value = objects.get(pathname);
        if (!value) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.end(Buffer.from(value));
        return;
      }
      if (request.method === "DELETE") {
        objects.delete(pathname);
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 405;
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FAKE_OBJECT_STORE_ADDRESS_MISSING");
  return { server, endpoint: `http://127.0.0.1:${address.port}/`, objects, objectPutCount: () => objectPutCount };
}

function config(endpoint: string): PiWorkspaceSupervisorConfig {
  return {
    rootDirectory: "C:/pi-workspaces",
    forgejoBaseUrl: "https://forgejo.example/",
    forgejoUsername: "runner",
    forgejoToken: "forgejo-token",
    s3Endpoint: endpoint,
    s3AccessKey: "access-key",
    s3SecretKey: "secret-key",
    s3Bucket: "pi-artifacts",
    s3Region: "us-east-1",
    publicBaseUrl: "https://workspace.example/",
  };
}

function scope(actorId: string): PiWorkspaceSupervisorContext {
  return { tenantId: "tenant-a", actorId, sessionId: `session-${actorId}`, runId: `run-${actorId}`, traceId: `trace-${actorId}` };
}

function writeInput(current: PiWorkspaceSupervisorContext, bytes: Uint8Array, classification: PiArtifactClassification = "internal") {
  return { scope: current, artifactId: "artifact-scope-test", version: 1, bytes, mediaType: "text/plain", classification };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Pi Workspace Supervisor object scope and grant lifecycle", () => {
  it("makes same-scope writes idempotent and rejects cross-scope or content-overwrite collisions", async () => {
    const fake = await startFakeObjectStore();
    const store = new S3WorkspaceObjectStore(config(fake.endpoint));
    const actorA = scope("actor-a");
    const actorB = scope("actor-b");
    const bytes = new TextEncoder().encode("version-one");
    const first = await store.put(writeInput(actorA, bytes));

    await expect(store.put(writeInput(actorA, bytes))).resolves.toMatchObject(first);
    expect(fake.objectPutCount()).toBe(1);
    await expect(store.put(writeInput(actorB, bytes))).rejects.toThrow("PI_OBJECT_SCOPE_MISMATCH");
    await expect(store.put(writeInput(actorA, new TextEncoder().encode("different")))).rejects.toThrow("PI_OBJECT_DUPLICATE");
    await expect(store.issueGrant({ scope: actorB, artifactId: "artifact-scope-test", version: 1, storageRef: first.storageRef, ttlMs: 60_000 })).rejects.toThrow("PI_OBJECT_NOT_FOUND");
    await expect(store.download((await store.issueGrant({ scope: actorA, artifactId: "artifact-scope-test", version: 1, storageRef: first.storageRef, ttlMs: 60_000 })).grantRef)).resolves.toMatchObject({ bytes });
  });

  it("rejects expired grants and keeps revocation scope-bound", async () => {
    const fake = await startFakeObjectStore();
    const store = new S3WorkspaceObjectStore(config(fake.endpoint));
    const actorA = scope("actor-a");
    const actorB = scope("actor-b");
    const bytes = new TextEncoder().encode("grant-lifecycle");
    const object = await store.put(writeInput(actorA, bytes));
    const expired = await store.issueGrant({ scope: actorA, artifactId: "artifact-scope-test", version: 1, storageRef: object.storageRef, ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(store.download(expired.grantRef)).rejects.toThrow("PI_DOWNLOAD_GRANT_EXPIRED");

    const active = await store.issueGrant({ scope: actorA, artifactId: "artifact-scope-test", version: 1, storageRef: object.storageRef, ttlMs: 60_000 });
    await expect(store.revokeGrant(actorB, active.grantRef)).rejects.toThrow("PI_DOWNLOAD_GRANT_NOT_FOUND");
    await expect(store.download(active.grantRef)).resolves.toMatchObject({ object: { contentDigest: object.contentDigest } });
    await store.revokeGrant(actorA, active.grantRef);
    await expect(store.download(active.grantRef)).rejects.toThrow("PI_DOWNLOAD_GRANT_NOT_FOUND");
  });
});
