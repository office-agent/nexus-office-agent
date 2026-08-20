import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MigrationDatabase } from "@/src/platform/database/executor";

export type MigrationResult = { version: string; status: "applied" | "skipped"; checksum: string };
export type MigrationOptions = { throughVersion?: string };
export type MigrationRollbackResult = { version: string; status: "rolled_back"; checksum: string };

function migrationBody(sql: string, version: string): string {
  const normalized = sql.trim();
  if (!/^BEGIN;\s*/i.test(normalized)) return normalized;
  if (!/\s*COMMIT;$/i.test(normalized)) throw new Error(`MIGRATION_TRANSACTION_BOUNDARY_INVALID:${version}`);
  return normalized.replace(/^BEGIN;\s*/i, "").replace(/\s*COMMIT;$/i, "").trim();
}

export async function runMigrations(database: MigrationDatabase, directory: string, options: MigrationOptions = {}): Promise<MigrationResult[]> {
  await database.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)",
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const selectedFiles = options.throughVersion
    ? files.filter((file) => file.replace(/\.sql$/, "") <= options.throughVersion!)
    : files;
  if (options.throughVersion && !files.some((file) => file.replace(/\.sql$/, "") === options.throughVersion)) {
    throw new Error(`MIGRATION_TARGET_NOT_FOUND:${options.throughVersion}`);
  }
  return database.transaction(async (executor) => {
    await executor.query("SELECT pg_advisory_xact_lock(hashtext('nexus-office-schema-migrations'))");
    const results: MigrationResult[] = [];
    for (const file of selectedFiles) {
      const sql = await readFile(path.join(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const version = file.replace(/\.sql$/, "");
      const existing = await executor.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (existing.length > 0) {
        if (existing[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${version}`);
        results.push({ version, status: "skipped", checksum });
        continue;
      }
      await executor.query(migrationBody(sql, version));
      await executor.query("INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)", [version, checksum]);
      results.push({ version, status: "applied", checksum });
    }
    return results;
  });
}

/**
 * Roll back one migration only in a disposable/controlled environment.
 * Production upgrades use expand/contract and must not destroy recorded data;
 * the explicit down file exists to prove rollback/forward compatibility in a
 * fresh database and is therefore guarded to the latest applied version.
 */
export async function rollbackMigration(database: MigrationDatabase, directory: string, version: string): Promise<MigrationRollbackResult> {
  const upPath = path.join(directory, `${version}.sql`);
  const downPath = path.join(directory, "down", `${version}.sql`);
  await access(upPath);
  await access(downPath);
  const upSql = await readFile(upPath, "utf8");
  const downSql = await readFile(downPath, "utf8");
  const checksum = createHash("sha256").update(upSql).digest("hex");
  return database.transaction(async (executor) => {
    await executor.query("SELECT pg_advisory_xact_lock(hashtext('nexus-office-schema-migrations'))");
    const applied = await executor.query<{ version: string; checksum: string }>(
      "SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    if (applied[0]?.version !== version) throw new Error(`MIGRATION_ROLLBACK_NOT_LATEST:${version}`);
    if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${version}`);
    await executor.query(migrationBody(downSql, `${version}.down`));
    await executor.query("DELETE FROM schema_migrations WHERE version=$1", [version]);
    return { version, status: "rolled_back", checksum };
  });
}
