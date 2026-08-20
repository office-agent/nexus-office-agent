import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptDatabaseBackup } from "@/src/platform/operations/backup-crypto";
import { resolveOperationalKey, runTool } from "./operations-shared";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const targetUri = process.env.BACKUP_TARGET_URI;
  const keyReference = process.env.BACKUP_ENCRYPTION_KEY_REF;
  if (!databaseUrl || !targetUri || !keyReference) throw new Error("BACKUP_CONFIG_REQUIRED");
  const target = new URL(targetUri);
  if (target.protocol !== "file:") throw new Error("BACKUP_TARGET_DRIVER_UNSUPPORTED");
  const targetDirectory = fileURLToPath(target);
  await mkdir(targetDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nexus-backup-"));
  const rawPath = join(temporaryDirectory, "database.dump");
  try {
    await runTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", rawPath, databaseUrl]);
    const key = await resolveOperationalKey(keyReference, "backup-encryption");
    const { encrypted, manifest } = encryptDatabaseBackup(await readFile(rawPath), key);
    const timestamp = manifest.createdAt.replace(/[:.]/g, "-");
    const base = `nexus-${timestamp}`;
    const encryptedTemporary = join(targetDirectory, `.${base}.dump.enc.tmp`);
    const manifestTemporary = join(targetDirectory, `.${base}.manifest.json.tmp`);
    await writeFile(encryptedTemporary, encrypted, { flag: "wx" });
    await writeFile(manifestTemporary, JSON.stringify({ ...manifest, artifact: basename(`${base}.dump.enc`) }, null, 2), { flag: "wx", encoding: "utf8" });
    await rename(encryptedTemporary, join(targetDirectory, `${base}.dump.enc`));
    await rename(manifestTemporary, join(targetDirectory, `${base}.manifest.json`));
    process.stdout.write(JSON.stringify({ status: "created", manifest: `${base}.manifest.json`, encryptedSha256: manifest.encryptedSha256 }) + "\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "BACKUP_FAILED" }) + "\n");
  process.exitCode = 1;
});
