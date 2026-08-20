// Requirements: PR-011, SR-007, DR-011
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Pi Change Delivery lease migration", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(path.join(directory, file), "utf8"));
    }
  });

  afterEach(async () => { await database.close(); });

  it("adds lease fencing, rejects a leased row without a lease and can roll back/reapply", async () => {
    const columns = await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='pi_delivery_outbox' AND column_name = ANY($1::text[]) ORDER BY column_name", [["lease_owner", "lease_token", "lease_expires_at"]]);
    expect(columns.rows.map((row) => row.column_name)).toEqual(["lease_expires_at", "lease_owner", "lease_token"]);
    const constraint = await database.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='pi_delivery_outbox_lease_check'");
    expect(constraint.rows[0].definition).toContain("lease_owner IS NOT NULL");
    expect(constraint.rows[0].definition).toContain("lease_token IS NOT NULL");

    const heartbeatConstraint = await database.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='worker_heartbeats_role_check'");
    expect(heartbeatConstraint.rows[0].definition).toContain("pi-change-delivery");

    const down = await readFile(path.resolve("src/platform/database/migrations/down/0042_pi_change_delivery_leases.sql"), "utf8");
    await database.exec(down);
    const rolledBack = await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='pi_delivery_outbox' AND column_name = ANY($1::text[])", [["lease_owner", "lease_token", "lease_expires_at"]]);
    expect(rolledBack.rows).toHaveLength(0);
    await database.exec(await readFile(path.resolve("src/platform/database/migrations/0042_pi_change_delivery_leases.sql"), "utf8"));
    const reapplied = await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='pi_delivery_outbox' AND column_name = ANY($1::text[])", [["lease_owner", "lease_token", "lease_expires_at"]]);
    expect(reapplied.rows).toHaveLength(3);
  });
});
