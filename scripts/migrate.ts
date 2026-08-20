import path from "node:path";
import { createPostgresDatabase } from "../src/platform/database/postgres";
import { rollbackMigration, runMigrations } from "../src/platform/database/migrator";

const databaseUrl = process.env.DATABASE_URL;
async function main() {
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured. Use the deployment secret manager or a local untracked environment file.");
    process.exitCode = 1;
    return;
  }

  const database = createPostgresDatabase(databaseUrl);
  try {
    const directory = path.resolve("src/platform/database/migrations");
    const rollbackVersionIndex = process.argv.indexOf("--rollback");
    if (rollbackVersionIndex >= 0) {
      const version = process.argv[rollbackVersionIndex + 1];
      if (!version) throw new Error("MIGRATION_ROLLBACK_VERSION_REQUIRED");
      console.info(JSON.stringify(await rollbackMigration(database, directory, version)));
    } else {
      const throughIndex = process.argv.indexOf("--through");
      const throughVersion = throughIndex >= 0 ? process.argv[throughIndex + 1] : undefined;
      if (throughIndex >= 0 && !throughVersion) throw new Error("MIGRATION_THROUGH_VERSION_REQUIRED");
      const results = await runMigrations(database, directory, { throughVersion });
      console.info(JSON.stringify(results.map(({ version, status }) => ({ version, status }))));
    }
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
