import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decryptDatabaseBackup, restoreConfirmation, type BackupManifest } from "@/src/platform/operations/backup-crypto";
import { resolveOperationalKey, runTool } from "./operations-shared";

async function main() {
  const manifestArgument = process.argv.find((value) => value.startsWith("--manifest="))?.slice("--manifest=".length);
  const dryRun = process.argv.includes("--dry-run");
  const restoreDatabaseUrl = process.env.RESTORE_DATABASE_URL;
  const keyReference = process.env.BACKUP_ENCRYPTION_KEY_REF;
  if (!manifestArgument || !keyReference || (!dryRun && !restoreDatabaseUrl)) throw new Error("RESTORE_CONFIG_REQUIRED");
  const manifestPath = resolve(manifestArgument);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest & { artifact?: string };
  if (!manifest.artifact || dirname(resolve(dirname(manifestPath), manifest.artifact)) !== dirname(manifestPath)) throw new Error("RESTORE_ARTIFACT_INVALID");
  const encrypted = await readFile(resolve(dirname(manifestPath), manifest.artifact));
  const key = await resolveOperationalKey(keyReference, "backup-restore");
  const plaintext = decryptDatabaseBackup(encrypted, manifest, key);
  if (dryRun) {
    process.stdout.write(JSON.stringify({ status: "verified", encryptedSha256: manifest.encryptedSha256, requiredConfirmation: restoreConfirmation(manifest) }) + "\n");
    return;
  }
  if (process.env.NEXUS_RESTORE_CONFIRM !== restoreConfirmation(manifest)) throw new Error("RESTORE_CONFIRMATION_REQUIRED");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nexus-restore-"));
  const rawPath = join(temporaryDirectory, "database.dump");
  try {
    await writeFile(rawPath, plaintext, { flag: "wx" });
    await runTool("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", restoreDatabaseUrl!, rawPath]);
    process.stdout.write(JSON.stringify({ status: "restored", encryptedSha256: manifest.encryptedSha256 }) + "\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "RESTORE_FAILED" }) + "\n");
  process.exitCode = 1;
});
