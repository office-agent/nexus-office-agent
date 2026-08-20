// Requirements: PR-010, PR-011, SR-006, SR-007, AC-011, AC-012, DR-011, DR-012
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PiPilotService } from "@/src/modules/pi-agent/application/pilot-service";
import { PostgresPiPilotStore } from "@/src/modules/pi-agent/infrastructure/m33-store";
import { PiReleaseGovernanceService } from "@/src/modules/pi-agent/application/release-governance-service";
import { PostgresPiReleaseGovernanceStore } from "@/src/modules/pi-agent/infrastructure/m34-store";

const TENANT_A = "76000000-0000-4000-8000-000000000001";
const ACTOR_A = "76000000-0000-4000-8000-000000000002";
const TENANT_B = "76000000-0000-4000-8000-000000000011";
const ACTOR_B = "76000000-0000-4000-8000-000000000012";
const DIGEST = "e".repeat(64);

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId: "76000000-0000-4000-8000-000000000099",
    channel: "web",
    traceId: `postgres-m33-m34-${tenantId}`,
    roles: [],
    permissions: [
      "pi:pilot:read",
      "pi:pilot:manage",
      "pi:pilot:exit",
      "pi:release:read",
      "pi:release:manage",
      "pi:release:approve",
      "pi:release:rollout",
      "pi:release:revoke",
    ],
    dataScopes: [{ type: "tenant" }],
  };
}

describe("PostgreSQL Pi M33/M34 governance control planes", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const migrationDirectory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(path.join(migrationDirectory, file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'m33-m34-a','M33 M34 A','active'),($2,'m33-m34-b','M33 M34 B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'M33 M34 A','m33-m34-a@example.test','active'),($3,$4,'M33 M34 B','m33-m34-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("persists M33 pilot facts with tenant isolation and fail-closed evidence", async () => {
    const service = new PiPilotService(new PostgresPiPilotStore(adapter));
    const owner = context();
    const pilot = await service.createPilot(owner, {
      projectId: "project-a",
      name: "M33 Pilot A",
      version: "1.0.0-pilot-rc",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
      exitPolicyDigest: DIGEST,
    }, "postgres-m33-pilot-a");
    await service.addParticipant(owner, pilot.id, { subjectDigest: DIGEST, role: "engineer", projectScopeDigest: "f".repeat(64) });
    const journey = await service.recordJourney(owner, pilot.id, { kind: "new_feature", sampleDigest: DIGEST });
    expect(journey.status).toBe("pending");
    expect((await service.evaluateReadiness(owner, pilot.id)).ready).toBe(false);
    expect((await service.snapshot(context(TENANT_B, ACTOR_B))).pilots).toHaveLength(0);

    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_pilots WHERE tenant_id=$1", [TENANT_B])).rows[0].count)).toBe(0);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_pilot_journeys WHERE tenant_id=$1", [TENANT_B])).rows[0].count)).toBe(0);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_pilots WHERE tenant_id=$1", [TENANT_A])).rows[0].count)).toBe(1);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_pilot_events WHERE tenant_id=$1", [TENANT_A])).rows[0].count)).toBeGreaterThanOrEqual(3);
  });

  it("persists M34 publication governance, records only digests and keeps the gate closed", async () => {
    const service = new PiReleaseGovernanceService(new PostgresPiReleaseGovernanceStore(adapter));
    const owner = context();
    const publication = await service.createPublication(owner, {
      version: "1.0.0",
      upstreamVersion: "0.1.0",
      apiDigest: DIGEST,
      schemaDigest: "f".repeat(64),
      imageDigest: "1".repeat(64),
      signatureDigest: "2".repeat(64),
      sbomDigest: "3".repeat(64),
      rollbackDigest: "4".repeat(64),
    }, "postgres-m34-publication-a");
    await service.recordGateAttestation(owner, publication.id, { gateId: "G-025", evidenceDigest: DIGEST, validUntil: "2099-01-01T00:00:00.000Z" });
    await service.recordRisk(owner, publication.id, { severity: "P2", summaryDigest: "5".repeat(64) });
    const evaluation = await service.evaluateReleaseGate(owner, publication.id);
    expect(evaluation.ready).toBe(false);
    expect((await service.snapshot(context(TENANT_B, ACTOR_B))).publications).toHaveLength(0);

    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_publications WHERE tenant_id=$1", [TENANT_B])).rows[0].count)).toBe(0);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    expect(Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_publications WHERE tenant_id=$1", [TENANT_A])).rows[0].count)).toBe(1);
    const stored = await database.query<{ api_digest: string; image_digest: string }>("SELECT api_digest,image_digest FROM pi_publications WHERE id=$1", [publication.id]);
    expect(stored.rows[0].api_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].image_digest).not.toContain("secret://");
  });

  it("enables FORCE RLS on every M33/M34 governance table", async () => {
    const names = [
      "pi_pilots", "pi_pilot_participants", "pi_pilot_journeys", "pi_pilot_observations", "pi_pilot_data_samples", "pi_pilot_incidents", "pi_pilot_readiness", "pi_pilot_events",
      "pi_publications", "pi_gate_attestations", "pi_release_risks", "pi_release_approvals", "pi_rollouts", "pi_release_evaluations", "pi_release_gate_evaluations", "pi_release_governance_events",
    ];
    const result = await database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname", [names]);
    expect(result.rows).toHaveLength(names.length);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
