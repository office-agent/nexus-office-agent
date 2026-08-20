// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { PiWorkspaceSupervisorState } from "@/src/modules/pi-agent/workspace-supervisor/contracts";
import { InMemoryPiWorkspaceSupervisorStateStore, JsonFilePiWorkspaceSupervisorStateStore } from "@/src/modules/pi-agent/workspace-supervisor/state-store";
import { S3WorkspaceObjectStore } from "@/src/modules/pi-agent/workspace-supervisor/s3-object-store";

const emptyState = (): PiWorkspaceSupervisorState => ({ schemaVersion: 1, leases: [], workspaces: [], objects: [], grants: [] });

describe("Pi Workspace Supervisor durable state", () => {
  it("round-trips metadata through an atomic JSON file without provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-supervisor-state-"));
    const file = join(root, "state.json");
    try {
      const store = new JsonFilePiWorkspaceSupervisorStateStore(file);
      await store.save(emptyState());
      expect(await store.load()).toEqual(emptyState());
      const raw = await readFile(file, "utf8");
      expect(raw).not.toMatch(/token|secret|password|authorization|private.?key/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed state and forbidden credential fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-supervisor-state-"));
    const file = join(root, "state.json");
    try {
      const store = new JsonFilePiWorkspaceSupervisorStateStore(file);
      await writeFile(file, JSON.stringify({ schemaVersion: 99, leases: [], workspaces: [], objects: [], grants: [] }), "utf8");
      await expect(store.load()).rejects.toThrow("PI_WORKSPACE_STATE_INVALID");
      const inMemory = new InMemoryPiWorkspaceSupervisorStateStore();
      await expect(inMemory.save({ ...emptyState(), leases: [{ token: "must-not-persist" }] } as never)).rejects.toThrow("PI_WORKSPACE_STATE_SECRET_FORBIDDEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not restore an expired object download grant", () => {
    const object = {
      storageRef: "s3://pi-artifacts/10000000-0000-4000-8000-000000000001/artifact/1",
      objectVersion: "etag-1",
      scope: { tenantId: "10000000-0000-4000-8000-000000000001", actorId: "10000000-0000-4000-8000-000000000002", sessionId: "session", runId: "run", traceId: "trace" },
      artifactId: "artifact",
      version: 1,
      sizeBytes: 3,
      contentDigest: "a".repeat(64),
      mediaType: "text/plain",
      classification: "internal" as const,
    };
    const store = new S3WorkspaceObjectStore({ s3Endpoint: "https://objects.example/", s3AccessKey: "a".repeat(16), s3SecretKey: "s".repeat(40), s3Region: "us-east-1", s3Bucket: "pi-artifacts", publicBaseUrl: "https://workspace.example/", rootDirectory: "C:/pi", forgejoBaseUrl: "https://forgejo.example/", forgejoUsername: "user", forgejoToken: "t".repeat(40) });
    store.restore({ objects: [object], grants: [{ grantRef: "grant-expired", storageRef: object.storageRef, expiresAt: new Date(Date.now() - 1_000).toISOString() }] });
    expect(store.snapshot().objects).toHaveLength(1);
    expect(store.snapshot().grants).toHaveLength(0);
  });
});
