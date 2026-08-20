// Requirements: AR-009, IR-007, SR-005, AC-008, AC-010, DR-011
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decryptDatabaseBackup, encryptDatabaseBackup, restoreConfirmation } from "@/src/platform/operations/backup-crypto";
import { ManagedHttpConnectorSecretResolver } from "@/src/modules/integration/infrastructure/secret-resolver";
import { consumeLocalAuthRateLimit } from "@/src/platform/http/security-policy";
import { incrementCounter, redactOperationalFields, telemetrySnapshot } from "@/src/platform/observability/telemetry";

describe("production operations", () => {
  it("encrypts, verifies and detects tampering in backup artifacts", () => {
    const key = randomBytes(32);
    const result = encryptDatabaseBackup(Buffer.from("postgres fixture"), key, new Date("2026-08-05T00:00:00Z"));
    expect(decryptDatabaseBackup(result.encrypted, result.manifest, key).toString()).toBe("postgres fixture");
    expect(restoreConfirmation(result.manifest)).toMatch(/^RESTORE_[A-F0-9]{12}$/);
    const tampered = Buffer.from(result.encrypted); tampered[0] ^= 1;
    expect(() => decryptDatabaseBackup(tampered, result.manifest, key)).toThrow("BACKUP_INTEGRITY_FAILED");
  });

  it("resolves opaque connector references through the managed service and caches briefly", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: { verificationToken: "verification", encryptKey: "encryption" } })) as unknown as typeof fetch;
    const resolver = new ManagedHttpConnectorSecretResolver("https://vault.example/resolve", "bootstrap", fetcher);
    expect(await resolver.resolve("secret://tenant-a/feishu", "feishu")).toEqual({ verificationToken: "verification", encryptKey: "encryption" });
    await resolver.resolve("secret://tenant-a/feishu", "feishu");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(resolver.resolve("inline-secret", "feishu")).rejects.toThrow("CONNECTOR_SECRET_REF_INVALID");
  });

  it("redacts operational fields and applies the local authentication safety limit", () => {
    expect(redactOperationalFields({ authorization: "Bearer real", traceId: "trace", access_token: "real" })).toEqual({ authorization: "[REDACTED]", traceId: "trace", access_token: "[REDACTED]" });
    const key = `test-${crypto.randomUUID()}`;
    expect(consumeLocalAuthRateLimit(key, 0, 2, 1000).allowed).toBe(true);
    expect(consumeLocalAuthRateLimit(key, 1, 2, 1000).allowed).toBe(true);
    expect(consumeLocalAuthRateLimit(key, 2, 2, 1000).allowed).toBe(false);
    incrementCounter("test.counter", { outcome: "success" });
    expect(telemetrySnapshot().counters.some((entry) => entry.name === "test.counter")).toBe(true);
  });

  it("deploys Web, Workers and operations from the same durable runtime release", async () => {
    const [dockerfile, nexus, migration, backup] = await Promise.all([
      readFile(path.resolve("Dockerfile"), "utf8"),
      readFile(path.resolve("deploy/kubernetes/nexus.yaml"), "utf8"),
      readFile(path.resolve("deploy/kubernetes/migration-job.yaml"), "utf8"),
      readFile(path.resolve("deploy/kubernetes/backup-cronjob.yaml"), "utf8"),
    ]);
    expect(dockerfile).toContain("AS worker");
    expect(dockerfile).toContain("scripts/worker.ts");
    expect((nexus.match(/nexus-office-worker:0\.14\.0/g) ?? [])).toHaveLength(3);
    expect(nexus).toContain("nexus-office:0.14.0");
    expect(nexus).toContain("NEXUS_RELEASE_VERSION: 0.14.0");
    expect(nexus).toContain("REQUIRED_WORKER_ROLES: inbox,agent,outbox");
    expect(migration).toContain("nexus-office-operations:0.14.0");
    expect(backup).toContain("nexus-office-operations:0.14.0");
    expect(`${nexus}\n${migration}\n${backup}`).not.toMatch(/nexus-office(?:-worker|-operations)?:0\.(?:9|11)\.0/);
  });
});
