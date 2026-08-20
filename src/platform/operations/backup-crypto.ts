import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type BackupManifest = {
  version: 1;
  createdAt: string;
  format: "postgres-custom+aes-256-gcm";
  encryptedSha256: string;
  initializationVector: string;
  authenticationTag: string;
  recoveryObjectives: { rpoMinutes: 15; rtoMinutes: 120 };
};

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY_INVALID");
}

export function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptDatabaseBackup(plaintext: Buffer, key: Buffer, now = new Date()): { encrypted: Buffer; manifest: BackupManifest } {
  assertKey(key);
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return {
    encrypted,
    manifest: {
      version: 1,
      createdAt: now.toISOString(),
      format: "postgres-custom+aes-256-gcm",
      encryptedSha256: sha256(encrypted),
      initializationVector: initializationVector.toString("base64"),
      authenticationTag: authenticationTag.toString("base64"),
      recoveryObjectives: { rpoMinutes: 15, rtoMinutes: 120 },
    },
  };
}

export function decryptDatabaseBackup(encrypted: Buffer, manifest: BackupManifest, key: Buffer): Buffer {
  assertKey(key);
  if (manifest.version !== 1 || manifest.format !== "postgres-custom+aes-256-gcm" || sha256(encrypted) !== manifest.encryptedSha256) throw new Error("BACKUP_INTEGRITY_FAILED");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(manifest.initializationVector, "base64"));
    decipher.setAuthTag(Buffer.from(manifest.authenticationTag, "base64"));
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("BACKUP_DECRYPTION_FAILED");
  }
}

export function restoreConfirmation(manifest: BackupManifest): string {
  return `RESTORE_${manifest.encryptedSha256.slice(0, 12).toUpperCase()}`;
}
