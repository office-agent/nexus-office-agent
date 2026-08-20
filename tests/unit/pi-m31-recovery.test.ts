// Requirements: PR-008, SR-005, AC-013, DR-010
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";
import { InMemoryPiRecoveryAdapter, InMemoryPiRecoveryEventSink, PiRecoveryService } from "@/src/modules/pi-agent/application/recovery-service";
import { restoreConfirmation } from "@/src/platform/operations/backup-crypto";

describe("Pi M31 local recovery and rollback control", () => {
  it("encrypts a tenant-scoped backup and restores only with explicit confirmation", async () => {
    const adapter = new InMemoryPiRecoveryAdapter();
    const events = new InMemoryPiRecoveryEventSink();
    const service = new PiRecoveryService(adapter, events);
    const owner = createDevelopmentRequestContext("m31-recovery-owner");
    const otherTenant = { ...owner, tenantId: "tenant-other", traceId: "m31-recovery-other" };
    const key = randomBytes(32);
    const plaintext = Buffer.from("tenant-a recovery fixture");

    const backup = await service.backup(owner, plaintext, key);
    expect(backup.manifest).not.toHaveProperty("authenticationTag");
    expect(backup.manifest).not.toHaveProperty("initializationVector");
    await expect(service.restore(otherTenant, backup.backupId, key, "wrong")).rejects.toThrow("PI_RECOVERY_BACKUP_NOT_FOUND");
    await expect(service.restore(owner, backup.backupId, key, "wrong")).rejects.toThrow("PI_RECOVERY_CONFIRMATION_INVALID");
    const stored = await adapter.loadBackup(owner, backup.backupId);
    expect(stored).not.toBeNull();
    const restored = await service.restore(owner, backup.backupId, key, restoreConfirmation(stored!.manifest));
    expect(restored.action).toBe("restore");
    expect(adapter.restoredDigest).toBeDefined();
    expect(events.events.map((event) => event.type)).toEqual(["pi.recovery.completed", "pi.recovery.completed"]);
    expect(service.listActions(otherTenant)).toHaveLength(0);
  });

  it("records an immutable release rollout and rollback action", async () => {
    const service = new PiRecoveryService(new InMemoryPiRecoveryAdapter());
    const owner = createDevelopmentRequestContext("m31-release-owner");
    const release = service.registerRelease(owner, { version: "0.20.0-security-candidate", imageDigest: "a".repeat(64) });
    expect(service.activateRelease(owner, release.id).status).toBe("active");
    const rolledBack = service.rollbackRelease(owner, release.id, "b".repeat(64));
    expect(rolledBack.status).toBe("rolled_back");
    expect(rolledBack.imageDigest).toBe("b".repeat(64));
    expect(service.listActions(owner).map((item) => item.action)).toEqual(["rollout", "rollback"]);
    const otherTenant = { ...owner, tenantId: "tenant-other", traceId: "m31-release-other" };
    expect(() => service.activateRelease(otherTenant, release.id)).toThrow("PI_RELEASE_NOT_FOUND");
  });
});
