// Requirements: AR-006, AR-009, AR-010, DR-011
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rollbackMigration, runMigrations } from "@/src/platform/database/migrator";
import type { DatabaseExecutor, MigrationDatabase, SqlPrimitive } from "@/src/platform/database/executor";

function executor(queryable: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }): DatabaseExecutor {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
      return (await queryable.query<T>(sql, params as unknown[])).rows;
    },
  };
}

describe("PostgreSQL migration runner", () => {
  let database: PGlite;
  let directory: string;
  let migrationDatabase: MigrationDatabase;

  beforeEach(async () => {
    database = new PGlite();
    directory = await mkdtemp(path.join(tmpdir(), "nexus-migrations-"));
    migrationDatabase = {
      ...executor(database),
      async transaction<T>(work: (scoped: DatabaseExecutor) => Promise<T>) {
        return database.transaction((transaction) => work(executor(transaction)));
      },
    };
  });

  afterEach(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("applies wrapped migration files and version receipts in one reserved transaction", async () => {
    await writeFile(path.join(directory, "0001_wrapped.sql"), "BEGIN;\nCREATE TABLE migration_probe(id integer PRIMARY KEY);\nCOMMIT;\n", "utf8");
    await writeFile(path.join(directory, "0002_unwrapped.sql"), "ALTER TABLE migration_probe ADD COLUMN label text;\n", "utf8");
    expect((await runMigrations(migrationDatabase, directory)).map(({ version, status }) => ({ version, status }))).toEqual([
      { version: "0001_wrapped", status: "applied" },
      { version: "0002_unwrapped", status: "applied" },
    ]);
    expect((await runMigrations(migrationDatabase, directory)).every(({ status }) => status === "skipped")).toBe(true);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(2);
  });

  it("rolls back schema changes and the receipt when a migration batch fails", async () => {
    await writeFile(path.join(directory, "0001_valid.sql"), "CREATE TABLE should_rollback(id integer PRIMARY KEY);\n", "utf8");
    await writeFile(path.join(directory, "0002_invalid.sql"), "ALTER TABLE table_that_does_not_exist ADD COLUMN broken text;\n", "utf8");
    await expect(runMigrations(migrationDatabase, directory)).rejects.toThrow();
    expect((await database.query<{ name: string | null }>("SELECT to_regclass('public.should_rollback')::text AS name")).rows[0].name).toBeNull();
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(0);
  });

  it("rolls back and reapplies the Pi run migration only when it is the latest receipt", async () => {
    await writeFile(path.join(directory, "0001_base.sql"), "CREATE TABLE migration_base(id integer PRIMARY KEY);\n", "utf8");
    await writeFile(path.join(directory, "0002_pi.sql"), "CREATE TABLE pi_run_commands(id integer PRIMARY KEY);\n", "utf8");
    await mkdir(path.join(directory, "down"), { recursive: true });
    await writeFile(path.join(directory, "down", "0002_pi.sql"), "DROP TABLE pi_run_commands;\n", "utf8");

    await runMigrations(migrationDatabase, directory, { throughVersion: "0002_pi" });
    expect((await database.query<{ name: string | null }>("SELECT to_regclass('public.pi_run_commands')::text AS name")).rows[0].name).toBe("pi_run_commands");
    const rolledBack = await rollbackMigration(migrationDatabase, directory, "0002_pi");
    expect(rolledBack.status).toBe("rolled_back");
    expect((await database.query<{ name: string | null }>("SELECT to_regclass('public.pi_run_commands')::text AS name")).rows[0].name).toBeNull();

    const reapplied = await runMigrations(migrationDatabase, directory, { throughVersion: "0002_pi" });
    expect(reapplied.at(-1)).toMatchObject({ version: "0002_pi", status: "applied" });
    expect((await database.query<{ name: string | null }>("SELECT to_regclass('public.pi_run_commands')::text AS name")).rows[0].name).toBe("pi_run_commands");
  });
});
