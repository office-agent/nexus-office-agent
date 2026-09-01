// Requirements: AR-002, AR-003, AR-004, AR-005, AR-010, IR-004, AC-005
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { PostgresNotificationDeliveryStore } from "@/src/modules/integration/infrastructure/postgres-notification-store";
import { PostgresConnectionRepository } from "@/src/modules/integration/infrastructure/connection-repository";
import { PostgresIdentityConnectorControlPlane } from "@/src/modules/integration/infrastructure/postgres-identity-control-plane";
import { PostgresWebhookReplayStore } from "@/src/modules/integration/infrastructure/webhook-replay-store";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";

const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const connectionId = "20000000-0000-4000-8000-000000000001";

describe("Postgres connector stores", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql", "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql", "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql", "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql", "0015_agent_job_control.sql"]) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(currentTenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id', $1, false)", [currentTenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [tenantId]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,status) VALUES($1,$2,'Manager','active')", [userId, tenantId]);
    await database.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref,transport_mode) VALUES($1,$2,'feishu','Main','active','secret://fixture','stream')", [connectionId, tenantId]);
  });

  afterEach(async () => { await database.close(); });

  it("persists inbound deduplication, processing state and notification receipts", async () => {
    const event = { eventId: "external-event-1", provider: "feishu" as const, connectionId, tenantId, eventType: "message.received", occurredAt: "2026-08-05T00:00:00.000Z", payload: { text: "hello" }, rawDigest: "a".repeat(64), schemaVersion: 1, traceId: "trace-connector-1" };
    const events = new PostgresEventStore(adapter);
    expect(await events.claimInbound(event)).toBe("accepted");
    expect(await events.claimInbound(event)).toBe("duplicate");
    await events.markInboundProcessed(event);

    const notifications = new PostgresNotificationDeliveryStore(adapter);
    const claim = { tenantId, notificationId: "notification-1", provider: "feishu" as const, connectionId, idempotencyKey: "notification-1:feishu", recipientDigest: "b".repeat(64), messageType: "info" as const, payloadDigest: "c".repeat(64) };
    expect(await notifications.claim(claim)).toBe(true);
    expect(await notifications.claim(claim)).toBe(false);
    await notifications.save({ tenantId, notificationId: "notification-1", provider: "feishu", connectionId, status: "delivered", attempts: 1, receipt: { externalMessageId: "message-1", acceptedAt: "2026-08-05T00:00:00.000Z", status: "accepted" } });
    expect(await notifications.get(tenantId, "notification-1")).toMatchObject({ status: "delivered", attempts: 1, receipt: { externalMessageId: "message-1" } });
    const counts = await database.query<{ inbox: number; deliveries: number }>("SELECT (SELECT count(*)::int FROM inbox_events) AS inbox, (SELECT count(*)::int FROM connector_deliveries) AS deliveries");
    expect(counts.rows[0]).toEqual({ inbox: 1, deliveries: 1 });
  });

  it("atomically claims one callback when identical deliveries arrive concurrently", async () => {
    const replays = new PostgresWebhookReplayStore(adapter);
    const claim = {
      tenantId,
      connectionId,
      provider: "feishu" as const,
      fingerprint: "d".repeat(64),
      rawDigest: "e".repeat(64),
      receivedAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T00:10:00.000Z",
    };

    const results = await Promise.all([replays.claim(claim), replays.claim(claim)]);
    expect(results.map(({ status }) => status).sort()).toEqual(["accepted", "duplicate"]);
    await expect(replays.claim({ ...claim, receivedAt: "2026-08-05T00:00:01.000Z" }))
      .resolves.toMatchObject({ status: "duplicate", firstReceivedAt: claim.receivedAt });
  });

  it("allows a replay fingerprint to be claimed again after its retention expires", async () => {
    const replays = new PostgresWebhookReplayStore(adapter);
    const original = {
      tenantId,
      connectionId,
      provider: "feishu" as const,
      fingerprint: "f".repeat(64),
      rawDigest: "a".repeat(64),
      receivedAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T00:01:00.000Z",
    };
    expect(await replays.claim(original)).toMatchObject({ status: "accepted", firstReceivedAt: original.receivedAt });

    expect(await replays.claim({
      ...original,
      receivedAt: "2026-08-05T00:02:00.000Z",
      expiresAt: "2026-08-05T00:12:00.000Z",
    })).toMatchObject({ status: "accepted", firstReceivedAt: "2026-08-05T00:02:00.000Z" });
  });

  it("resolves only the exact tenant, connection and provider binding", async () => {
    const connections = new PostgresConnectionRepository(adapter);

    await expect(connections.getForWebhook(tenantId, connectionId, "feishu")).resolves.toMatchObject({ id: connectionId, tenantId, provider: "feishu" });
    await expect(connections.getForWebhook("00000000-0000-4000-8000-000000000002", connectionId, "feishu")).resolves.toBeNull();
    await expect(connections.getForWebhook(tenantId, connectionId, "dingtalk")).resolves.toBeNull();
  });

  it("treats a revoked external identity as unresolved", async () => {
    await database.query(
      `INSERT INTO external_identities(id,tenant_id,connection_id,provider,subject_type,external_subject_id,internal_subject_type,internal_subject_id,status)
       VALUES($1,$2,$3,'feishu','user','ou-revoked','user',$4,'revoked')`,
      ["30000000-0000-4000-8000-000000000001", tenantId, connectionId, userId],
    );
    const identities = new PostgresIdentityConnectorControlPlane(adapter);

    await expect(identities.resolveIdentity("feishu", {
      tenantId,
      connectionId,
      subjectType: "user",
      externalSubjectId: "ou-revoked",
    })).resolves.toEqual({ externalSubjectId: "ou-revoked", status: "not_found" });
  });
});
