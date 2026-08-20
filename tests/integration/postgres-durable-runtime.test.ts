// Requirements: AR-002, AR-009, AR-010, IR-004, IR-005, IR-006, AC-003, AC-005, AC-006, DR-001, DR-002, DR-003, DR-004, DR-006, DR-007, DR-009, DR-014
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import type { DomainEvent, UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { failureFrom, RetryableWorkError } from "@/src/platform/workers/contracts";
import {
  PostgresAgentJobRepository,
  PostgresInboxWorkRepository,
  PostgresOutboxWorkRepository,
  PostgresWorkerHeartbeatRepository,
} from "@/src/platform/workers/postgres-work-repositories";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000001";
const RUN_ID = "30000000-0000-4000-8000-000000000001";
const PROPOSAL_ID = "40000000-0000-4000-8000-000000000001";
const CONFIRMATION_ID = "50000000-0000-4000-8000-000000000001";

describe("PostgreSQL durable runtime", () => {
  let pglite: PGlite;
  let database: TransactionalDatabase;

  beforeEach(async () => {
    pglite = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await pglite.exec(await readFile(path.join(directory, file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await pglite.query<T>(sql, params as never[])).rows;
      },
    };
    database = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await pglite.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await pglite.close(); },
    };

    await pglite.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'durable','Durable','active')", [TENANT_ID]);
    await pglite.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_ID]);
    await pglite.query("INSERT INTO users(id,tenant_id,display_name,status) VALUES($1,$2,'Operator','active')", [USER_ID,TENANT_ID]);
    await pglite.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref,transport_mode) VALUES($1,$2,'feishu','Primary','active','secret://durable','stream')", [CONNECTION_ID,TENANT_ID]);
    await pglite.query(
      "INSERT INTO agent_runs(id,tenant_id,actor_id,channel,trace_id,agent_profile,profile_version,model_policy,risk_level,status,input_digest) VALUES($1,$2,$3,'web','trace-agent','manager',1,'default',3,'awaiting_confirmation',$4)",
      [RUN_ID,TENANT_ID,USER_ID,"a".repeat(64)],
    );
    await pglite.query(
      "INSERT INTO agent_proposals(id,tenant_id,agent_run_id,actor_id,tool_id,tool_version,risk_level,input_payload,input_digest,preview,proposal_hash,status,expires_at) VALUES($1,$2,$3,$4,'management.create_risk',1,3,$5,$6,'preview',$7,'confirmed','2026-08-06T00:00:00.000Z')",
      [PROPOSAL_ID,TENANT_ID,RUN_ID,USER_ID,{ projectId: randomUUID() },"b".repeat(64),"c".repeat(64)],
    );
    await pglite.query(
      "INSERT INTO confirmations(id,tenant_id,agent_run_id,requested_by,proposal_hash,risk_level,status,expires_at,decided_at,decided_by,proposal_id) VALUES($1,$2,$3,$4,$5,3,'approved','2026-08-06T00:00:00.000Z','2026-08-05T00:00:00.000Z',$4,$6)",
      [CONFIRMATION_ID,TENANT_ID,RUN_ID,USER_ID,"c".repeat(64),PROPOSAL_ID],
    );
  });

  afterEach(async () => { await pglite.close(); });

  function event(eventId: string): UnifiedEvent {
    return {
      eventId,
      provider: "feishu",
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      eventType: "card.action",
      occurredAt: "2026-08-05T00:00:00.000Z",
      externalActor: { type: "open_id", id: "ou_operator" },
      externalContext: { chatId: "oc_management" },
      payload: { actionId: "confirm", proposalHash: "c".repeat(64) },
      rawDigest: "d".repeat(64),
      schemaVersion: 1,
      traceId: `trace-${eventId}`,
    };
  }

  it("DR-001 DR-002 persists the full envelope and atomically leases one inbox item", async () => {
    const store = new PostgresEventStore(database);
    const inbox = new PostgresInboxWorkRepository(database);
    expect(await store.claimInbound(event("event-full-envelope"))).toBe("accepted");

    const now = new Date("2030-08-05T00:00:01.000Z");
    const [first, second] = await Promise.all([
      inbox.claim(TENANT_ID, { workerId: "inbox-a", leaseMs: 30_000, now }),
      inbox.claim(TENANT_ID, { workerId: "inbox-b", leaseMs: 30_000, now }),
    ]);
    const lease = first ?? second;
    expect(lease).not.toBeNull();
    expect(first === null || second === null).toBe(true);
    expect(lease?.event).toMatchObject({
      eventId: "event-full-envelope",
      externalActor: { type: "open_id", id: "ou_operator" },
      externalContext: { chatId: "oc_management" },
    });
    expect(await inbox.complete({ ...lease!, leaseToken: randomUUID() }, "stale", now)).toBe(false);
    expect(await inbox.complete(lease!, "processed", now)).toBe(true);
  });

  it("DR-003 DR-004 reclaims an expired lease and rejects its stale token", async () => {
    const store = new PostgresEventStore(database);
    const inbox = new PostgresInboxWorkRepository(database);
    await store.claimInbound(event("event-reclaim"));
    const original = await inbox.claim(TENANT_ID, { workerId: "inbox-a", leaseMs: 1_000, now: new Date("2030-08-05T00:00:01.000Z") });
    const reclaimed = await inbox.claim(TENANT_ID, { workerId: "inbox-b", leaseMs: 1_000, now: new Date("2030-08-05T00:00:03.000Z") });
    expect(reclaimed?.id).toBe(original?.id);
    expect(reclaimed?.leaseToken).not.toBe(original?.leaseToken);
    expect(await inbox.complete(original!, "stale", new Date("2030-08-05T00:00:03.000Z"))).toBe(false);
    expect(await inbox.retry(
      reclaimed!,
      failureFrom(new RetryableWorkError("PLATFORM_RATE_LIMITED")),
      new Date("2030-08-05T00:00:05.000Z"),
      new Date("2030-08-05T00:00:03.000Z"),
    )).toBe("retry_scheduled");
  });

  it("DR-014 enforces the database tenant concurrency slot before leasing more work", async () => {
    const store = new PostgresEventStore(database);
    const inbox = new PostgresInboxWorkRepository(database);
    await store.claimInbound(event("event-concurrency-a"));
    await store.claimInbound(event("event-concurrency-b"));
    const now = new Date("2030-08-05T00:00:01.000Z");
    const first = await inbox.claim(TENANT_ID, { workerId: "inbox-a", leaseMs: 30_000, maxTenantConcurrency: 1, now });
    expect(first).not.toBeNull();
    expect(await inbox.claim(TENANT_ID, { workerId: "inbox-b", leaseMs: 30_000, maxTenantConcurrency: 1, now })).toBeNull();
    expect(await inbox.complete(first!, "processed", now)).toBe(true);
    expect(await inbox.claim(TENANT_ID, { workerId: "inbox-b", leaseMs: 30_000, maxTenantConcurrency: 1, now })).not.toBeNull();
  });

  it("DR-006 deduplicates publication after a post-publication crash", async () => {
    const eventId = randomUUID();
    const domainEvent: DomainEvent = {
      id: eventId,
      type: "risk.identified",
      version: 1,
      tenantId: TENANT_ID,
      aggregateType: "risk",
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      occurredAt: "2026-08-05T00:00:00.000Z",
      actor: { type: "system", id: "test" },
      traceId: "trace-outbox",
      payload: { source: "durable-test" },
    };
    await new PostgresEventStore(database).appendOutbox(domainEvent);
    const outbox = new PostgresOutboxWorkRepository(database);
    const original = await outbox.claim(TENANT_ID, { workerId: "outbox-a", leaseMs: 1_000, now: new Date("2030-08-05T00:00:01.000Z") });
    await database.withTenant(TENANT_ID, (executor) => executor.query(
      "INSERT INTO domain_event_publications(id,tenant_id,outbox_event_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,trace_id,publisher_instance_id,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'outbox-a',$10)",
      [randomUUID(),TENANT_ID,eventId,domainEvent.type,domainEvent.aggregateType,domainEvent.aggregateId,1,domainEvent.payload,domainEvent.traceId,new Date("2026-08-05T00:00:01.100Z")],
    ));

    const reclaimed = await outbox.claim(TENANT_ID, { workerId: "outbox-b", leaseMs: 1_000, now: new Date("2030-08-05T00:00:03.000Z") });
    expect(reclaimed?.id).toBe(original?.id);
    await outbox.publish(reclaimed!, "outbox-b", new Date("2030-08-05T00:00:03.100Z"));
    const count = await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM domain_event_publications WHERE outbox_event_id=$1", [eventId]);
    expect(count.rows[0].count).toBe(1);
  });

  it("DR-007 DR-009 makes Agent jobs idempotent and exposes only fresh compatible workers", async () => {
    const jobs = new PostgresAgentJobRepository(database);
    const job = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      agentRunId: RUN_ID,
      proposalId: PROPOSAL_ID,
      confirmationId: CONFIRMATION_ID,
      toolCallId: randomUUID(),
      actorId: USER_ID,
      sessionId: "session-1",
      channel: "web" as const,
      traceId: "trace-agent-job",
      toolId: "management.create_risk",
      toolVersion: 1,
      policyVersion: 1,
      riskLevel: 3 as const,
      inputPayload: { projectId: randomUUID(), riskId: randomUUID(), eventId: randomUUID() },
      inputDigest: "e".repeat(64),
      idempotencyKey: "c".repeat(64),
      expectedVersions: {},
      maxAttempts: 1,
      availableAt: "2026-08-05T00:00:00.000Z",
    };
    await pglite.query(
      "INSERT INTO tool_calls(id,tenant_id,agent_run_id,confirmation_id,tool_id,tool_version,risk_level,idempotency_key,input_digest,status) VALUES($1,$2,$3,$4,$5,1,3,$6,$7,'queued')",
      [job.toolCallId,TENANT_ID,RUN_ID,CONFIRMATION_ID,job.toolId,job.idempotencyKey,job.inputDigest],
    );
    expect(await jobs.enqueue(job)).toEqual({ id: job.id, created: true });
    expect(await jobs.enqueue({ ...job, id: randomUUID() })).toEqual({ id: job.id, created: false });
    const lease = await jobs.claim(TENANT_ID, { workerId: "agent-a", leaseMs: 1_000, now: new Date("2030-08-05T00:00:01.000Z") });
    expect(await jobs.retry(
      lease!,
      failureFrom(new RetryableWorkError("DATABASE_UNAVAILABLE")),
      new Date("2030-08-05T00:00:02.000Z"),
      new Date("2030-08-05T00:00:01.100Z"),
    )).toBe("dead_letter");

    const heartbeats = new PostgresWorkerHeartbeatRepository(database);
    await heartbeats.beat({ role: "inbox", instanceId: "inbox-a", releaseVersion: "0.12.0", capabilities: { lease: true }, startedAt: new Date("2026-08-05T00:00:00.000Z"), now: new Date("2026-08-05T00:00:10.000Z") });
    await heartbeats.beat({ role: "agent", instanceId: "agent-old", releaseVersion: "0.11.0", capabilities: {}, startedAt: new Date("2026-08-05T00:00:00.000Z"), now: new Date("2026-08-05T00:00:10.000Z") });
    expect(await heartbeats.freshRoles({ roles: ["inbox","agent","outbox"], releaseVersion: "0.12.0", now: new Date("2026-08-05T00:00:20.000Z"), maximumAgeMs: 15_000 })).toEqual(["inbox"]);
  });
});
