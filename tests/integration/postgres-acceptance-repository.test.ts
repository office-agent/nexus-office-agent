// Requirements: AR-002, AR-003, AR-004, AR-005, AR-010, SR-001, SR-004, IR-004, AC-001, AC-005
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegrationAcceptanceService, type AcceptanceProbeResult } from "@/src/modules/integration/application/acceptance";
import { TestNotificationService } from "@/src/modules/integration/application/test-notification";
import { PostgresAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { PostgresTestNotificationProposalRepository } from "@/src/modules/integration/infrastructure/test-notification-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";

const CONNECTION_ID = "22000000-0000-4000-8000-000000000001";
const result: AcceptanceProbeResult = { steps: ["connection", "organization_binding", "callback_secret", "token_exchange", "platform_api"].map((id) => ({ id, status: "passed" as const, summary: "通过", checkedAt: "2026-08-05T00:00:00.000Z" })), safeEvidence: { secretValuesPersisted: false, externalOrganizationBound: true } };

describe("Postgres enterprise acceptance evidence", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql"]) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { return database.transaction(async (transaction) => { await transaction.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]); return work({ async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await transaction.query<T>(sql, params as never[])).rows; } }); }); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'acceptance','Acceptance','active')", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,status) VALUES($1,$2,'Manager','active')", [DEMO_MANAGER_ID, DEMO_TENANT_ID]);
    await database.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref,transport_mode) VALUES($1,$2,'feishu','Acceptance','active','secret://acceptance/feishu','stream')", [CONNECTION_ID, DEMO_TENANT_ID]);
  });

  afterEach(async () => database.close());

  it("appends tenant-scoped acceptance runs and database audit evidence", async () => {
    const repository = new PostgresAcceptanceRepository(adapter);
    const service = new IntegrationAcceptanceService(repository, { async run() { return result; } }, { async run() { return result; } }, () => new Date("2026-08-05T00:00:00.000Z"));
    const context = createDevelopmentRequestContext("postgres-acceptance");

    await service.runIdentity(context);
    const connector = await service.runConnector(context, "feishu", CONNECTION_ID);
    const overview = await service.overview(context);

    expect(connector.status).toBe("passed");
    expect(overview.connections[0]?.latestRun?.id).toBe(connector.id);
    const counts = await database.query<{ runs: number; audits: number }>("SELECT (SELECT count(*)::int FROM enterprise_acceptance_runs) runs,(SELECT count(*)::int FROM audit_events WHERE resource_type='enterprise_acceptance_runs') audits");
    expect(counts.rows[0]).toEqual({ runs: 2, audits: 2 });
    const policies = await database.query<{ cmd: string }>("SELECT cmd FROM pg_policies WHERE tablename='enterprise_acceptance_runs' ORDER BY cmd");
    expect(policies.rows.map(({ cmd }) => cmd).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("atomically claims a hash-bound test delivery without persisting the recipient identifier", async () => {
    const acceptance = new PostgresAcceptanceRepository(adapter);
    const acceptanceService = new IntegrationAcceptanceService(acceptance, { async run() { return result; } }, { async run() { return result; } });
    const context = createDevelopmentRequestContext("postgres-test-delivery");
    await acceptanceService.runConnector(context, "feishu", CONNECTION_ID);

    const proposals = new PostgresTestNotificationProposalRepository(adapter);
    const gateway = { async deliver() { return { tenantId: DEMO_TENANT_ID, notificationId: "acceptance-test", provider: "feishu" as const, connectionId: CONNECTION_ID, status: "delivered" as const, attempts: 1, receipt: { externalMessageId: "om-postgres-receipt", acceptedAt: new Date().toISOString(), status: "accepted" as const } }; } };
    const service = new TestNotificationService(acceptance, proposals, gateway);
    const externalRecipientId = "ou-private-postgres-recipient";
    const proposal = await service.prepare(context, { provider: "feishu", connectionId: CONNECTION_ID, recipientType: "user", externalRecipientId });
    await expect(service.confirm(context, proposal.id, proposal.proposalHash, externalRecipientId)).resolves.toMatchObject({ status: "delivered" });

    const row = await database.query<{ recipient_digest: string; proposal_hash: string; status: string }>("SELECT recipient_digest,proposal_hash,status FROM connector_test_notification_proposals");
    expect(row.rows[0]).toMatchObject({ proposal_hash: proposal.proposalHash, status: "delivered" });
    expect(row.rows[0].recipient_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row.rows)).not.toContain(externalRecipientId);
    const audits = await database.query<{ count: number }>("SELECT count(*)::int count FROM audit_events WHERE resource_type='connector_test_notification_proposals'");
    expect(audits.rows[0].count).toBe(3);
    const policies = await database.query<{ cmd: string }>("SELECT cmd FROM pg_policies WHERE tablename='connector_test_notification_proposals' ORDER BY cmd");
    expect(policies.rows.map(({ cmd }) => cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
