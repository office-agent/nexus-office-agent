// Requirements: PR-009, SR-003, AC-006, AC-010
// Opt-in real PostgreSQL migration rollback/forward regression. Use only a disposable database.
// REAL_POSTGRES_PI_TEST=1 REAL_POSTGRES_PI_URL=postgres://... npx vitest run tests/integration/real-postgres-pi-migration-rollback.test.ts
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { rollbackMigration, runMigrations } from "@/src/platform/database/migrator";
import type { MigrationDatabase } from "@/src/platform/database/executor";

const enabled = process.env.REAL_POSTGRES_PI_TEST === "1" && Boolean(process.env.REAL_POSTGRES_PI_URL);
const realIt = enabled ? it : it.skip;

describe("real PostgreSQL Pi migration rollback/forward", () => {
  let database: (MigrationDatabase & { close(): Promise<void> }) | undefined;

  beforeAll(() => {
    if (enabled) database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);
  });

  afterAll(async () => {
    await database?.close();
  });

  realIt("rolls back and reapplies migration 0025 on a fresh database", async () => {
    const directory = path.resolve("src/platform/database/migrations");
    await runMigrations(database!, directory, { throughVersion: "0025_pi_run_control_plane" });
    const before = await database!.query<{ version: string; checksum: string }>("SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1");
    expect(before[0]?.version).toBe("0025_pi_run_control_plane");

    const rolledBack = await rollbackMigration(database!, directory, "0025_pi_run_control_plane");
    expect(rolledBack.status).toBe("rolled_back");
    expect((await database!.query<{ name: string | null }>("SELECT to_regclass('public.pi_run_commands')::text AS name"))[0]?.name).toBeNull();

    await runMigrations(database!, directory, { throughVersion: "0025_pi_run_control_plane" });
    const after = await database!.query<{ version: string; checksum: string }>("SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1");
    expect(after[0]?.version).toBe("0025_pi_run_control_plane");
    expect(after[0]?.checksum).toBe(rolledBack.checksum);
    expect((await database!.query<{ name: string | null }>("SELECT to_regclass('public.pi_run_commands')::text AS name"))[0]?.name).toBe("pi_run_commands");
  });
});
