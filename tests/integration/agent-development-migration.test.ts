// Requirements: PR-008, MR-050, AR-003, AR-005
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Agent development workflow migration", () => {
  let database: PGlite;
  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0044_agent_development_workflow.sql"]) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
  });
  afterEach(async () => { await database.close(); });

  it("creates five tenant-isolated and atomically audited workflow tables", async () => {
    const tables = ["agent_development_projects", "agent_development_documents", "agent_development_versions", "agent_development_tests", "agent_development_deliveries"];
    const controls = await database.query<{ table_name: string; forced: boolean; policy_count: number; audited: boolean }>(
      `SELECT c.relname AS table_name,c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='nexus_atomic_audit' AND NOT t.tgisinternal) AS audited
       FROM pg_class c WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, [tables],
    );
    expect(controls.rows).toHaveLength(5);
    expect(controls.rows.every((row) => row.forced && Number(row.policy_count) >= 1 && row.audited)).toBe(true);
    const permissions = await database.query<{ code: string }>("SELECT code FROM permissions WHERE code LIKE 'agent_development:%' ORDER BY code");
    expect(permissions.rows.map(({ code }) => code)).toEqual(["agent_development:deliver", "agent_development:read", "agent_development:write"]);
  });
});
