import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { decryptDatabaseBackup, encryptDatabaseBackup, restoreConfirmation, sha256, type BackupManifest } from "@/src/platform/operations/backup-crypto";

export type PiRecoveryBackup = {
  id: string;
  encrypted: Buffer;
  manifest: BackupManifest;
  tenantId: string;
  createdBy: string;
};

export type PiReleaseCandidate = {
  id: string;
  tenantId: string;
  version: string;
  imageDigest: string;
  status: "candidate" | "active" | "rolled_back";
  createdAt: string;
};

export type PiRecoveryAction = {
  id: string;
  tenantId: string;
  actorId: string;
  action: "backup" | "restore" | "rollout" | "rollback";
  subjectDigest: string;
  status: "started" | "completed" | "failed";
  traceId: string;
  createdAt: string;
};

export type PiRecoveryEvent = {
  type: "pi.recovery.completed";
  tenantId: string;
  actorId: string;
  traceId: string;
  action: PiRecoveryAction["action"];
  subjectDigest: string;
  status: PiRecoveryAction["status"];
  createdAt: string;
};

export interface PiRecoveryEventSink {
  append(event: PiRecoveryEvent): void;
}

export class InMemoryPiRecoveryEventSink implements PiRecoveryEventSink {
  readonly events: PiRecoveryEvent[] = [];
  append(event: PiRecoveryEvent): void { this.events.push({ ...event }); }
}

export interface PiRecoveryAdapter {
  saveBackup(backup: PiRecoveryBackup): Promise<void>;
  loadBackup(context: RequestContext, backupId: string): Promise<PiRecoveryBackup | null>;
  restoreDatabase(plaintext: Buffer): Promise<void>;
}

export class InMemoryPiRecoveryAdapter implements PiRecoveryAdapter {
  private readonly backups = new Map<string, PiRecoveryBackup>();
  restoredDigest?: string;
  async saveBackup(backup: PiRecoveryBackup): Promise<void> { this.backups.set(backup.id, { ...backup, encrypted: Buffer.from(backup.encrypted) }); }
  async loadBackup(context: RequestContext, backupId: string): Promise<PiRecoveryBackup | null> {
    const backup = this.backups.get(backupId);
    if (!backup || backup.tenantId !== context.tenantId) return null;
    return { ...backup, encrypted: Buffer.from(backup.encrypted) };
  }
  async restoreDatabase(plaintext: Buffer): Promise<void> { this.restoredDigest = sha256(plaintext); }
}

export class PiRecoveryService {
  private readonly releases = new Map<string, PiReleaseCandidate>();
  private readonly actions: PiRecoveryAction[] = [];

  constructor(private readonly adapter: PiRecoveryAdapter, private readonly eventSink: PiRecoveryEventSink = { append: () => undefined }) {}

  async backup(context: RequestContext, plaintext: Buffer, key: Buffer): Promise<{ backupId: string; manifest: Omit<BackupManifest, "authenticationTag" | "initializationVector">; action: PiRecoveryAction }> {
    assertPiPermission(context, "pi:recovery:write");
    const encrypted = encryptDatabaseBackup(plaintext, key);
    const backupId = randomUUID();
    await this.adapter.saveBackup({ id: backupId, encrypted: encrypted.encrypted, manifest: encrypted.manifest, tenantId: context.tenantId, createdBy: context.actorId });
    const action = this.recordAction(context, "backup", encrypted.manifest.encryptedSha256, "completed");
    return { backupId, manifest: { version: encrypted.manifest.version, createdAt: encrypted.manifest.createdAt, format: encrypted.manifest.format, encryptedSha256: encrypted.manifest.encryptedSha256, recoveryObjectives: encrypted.manifest.recoveryObjectives }, action };
  }

  async restore(context: RequestContext, backupId: string, key: Buffer, confirmation: string): Promise<PiRecoveryAction> {
    assertPiPermission(context, "pi:recovery:write");
    const backup = await this.adapter.loadBackup(context, backupId);
    if (!backup) throw new Error("PI_RECOVERY_BACKUP_NOT_FOUND");
    if (restoreConfirmation(backup.manifest) !== confirmation) throw new Error("PI_RECOVERY_CONFIRMATION_INVALID");
    const plaintext = decryptDatabaseBackup(backup.encrypted, backup.manifest, key);
    await this.adapter.restoreDatabase(plaintext);
    return this.recordAction(context, "restore", sha256(plaintext), "completed");
  }

  registerRelease(context: RequestContext, input: { version: string; imageDigest: string }): PiReleaseCandidate {
    assertPiPermission(context, "pi:release:propose");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error("PI_RELEASE_VERSION_INVALID");
    if (!/^[a-f0-9]{64}$/i.test(input.imageDigest)) throw new Error("PI_RELEASE_DIGEST_INVALID");
    const candidate: PiReleaseCandidate = { id: randomUUID(), tenantId: context.tenantId, version: input.version, imageDigest: input.imageDigest.toLowerCase(), status: "candidate", createdAt: new Date().toISOString() };
    this.releases.set(candidate.id, candidate);
    return { ...candidate };
  }

  activateRelease(context: RequestContext, releaseId: string): PiReleaseCandidate {
    assertPiPermission(context, "pi:release:propose");
    const candidate = this.releases.get(releaseId);
    if (!candidate || (context.channel !== "system" && candidate.tenantId !== context.tenantId)) throw new Error("PI_RELEASE_NOT_FOUND");
    if (candidate.status === "rolled_back") throw new Error("PI_RELEASE_STATE_CONFLICT");
    const active = { ...candidate, status: "active" as const };
    this.releases.set(releaseId, active);
    this.recordAction(context, "rollout", active.imageDigest, "completed");
    return { ...active };
  }

  rollbackRelease(context: RequestContext, releaseId: string, previousDigest: string): PiReleaseCandidate {
    assertPiPermission(context, "pi:release:propose");
    if (!/^[a-f0-9]{64}$/i.test(previousDigest)) throw new Error("PI_RELEASE_DIGEST_INVALID");
    const candidate = this.releases.get(releaseId);
    if (!candidate || (context.channel !== "system" && candidate.tenantId !== context.tenantId) || candidate.status !== "active") throw new Error("PI_RELEASE_STATE_CONFLICT");
    const rolledBack = { ...candidate, status: "rolled_back" as const };
    this.releases.set(releaseId, rolledBack);
    this.recordAction(context, "rollback", previousDigest.toLowerCase(), "completed");
    return { ...rolledBack, imageDigest: previousDigest.toLowerCase() };
  }

  listActions(context: RequestContext): PiRecoveryAction[] {
    assertPiPermission(context, "pi:recovery:read");
    return this.actions.filter((action) => context.channel === "system" || action.tenantId === context.tenantId).map((action) => ({ ...action }));
  }

  private recordAction(context: RequestContext, action: PiRecoveryAction["action"], subjectDigest: string, status: PiRecoveryAction["status"]): PiRecoveryAction {
    const result: PiRecoveryAction = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, action, subjectDigest, status, traceId: context.traceId, createdAt: new Date().toISOString() };
    this.actions.push(result);
    this.eventSink.append({ type: "pi.recovery.completed", tenantId: result.tenantId, actorId: result.actorId, traceId: result.traceId, action: result.action, subjectDigest: result.subjectDigest, status: result.status, createdAt: result.createdAt });
    return result;
  }
}
