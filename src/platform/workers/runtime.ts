import { randomUUID } from "node:crypto";
import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { getAgentOrchestrator, getAgentToolRegistry } from "@/src/modules/agent/runtime";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import { createIdentityConnectorRegistry, PostgresChannelActorContextResolver } from "@/src/modules/integration/infrastructure/postgres-identity-control-plane";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { ManagementChannelActionHandler } from "@/src/modules/management-intelligence/application/channel-action-handler";
import { createManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { PostgresAuthorizationResolver } from "@/src/platform/identity/authorization-resolver";
import { AgentJobWorker, DurableInboundEventHandler, InboxWorker, OutboxDispatcher } from "@/src/platform/workers/durable-workers";
import { PiChangeDeliveryOutboxWorker } from "@/src/modules/pi-agent/application/change-delivery-worker";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import { PostgresPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/postgres-change-delivery-store";
import { PiChangeDeliveryApprovalObjectVersionReader } from "@/src/modules/pi-agent/infrastructure/change-delivery-approval";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { createPiGitCredentialBroker, createPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { ApprovalPolicyResolver, FailClosedPiApprovalApproverDirectory, PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";
import { createPiChangeDeliveryGateways } from "@/src/modules/pi-agent/infrastructure/change-delivery-gateway";
import {
  PostgresAgentJobRepository,
  PostgresInboxWorkRepository,
  PostgresOutboxWorkRepository,
  PostgresTenantDirectory,
  PostgresWorkerHeartbeatRepository,
} from "@/src/platform/workers/postgres-work-repositories";
import { WorkerSupervisor, type TenantWorker } from "@/src/platform/workers/supervisor";
import type { WorkerRole } from "@/src/platform/workers/contracts";

function workerRoles(value = process.env.WORKER_ROLES ?? "inbox,agent,outbox"): WorkerRole[] {
  const roles = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (roles.some((role) => role !== "inbox" && role !== "agent" && role !== "outbox" && role !== "pi-change-delivery")) {
    if (roles.includes("pi-runner")) throw new Error("PI_RUNNER_REQUIRES_DEDICATED_ENTRYPOINT");
    throw new Error("WORKER_ROLE_INVALID");
  }
  if (roles.length === 0) throw new Error("WORKER_ROLE_REQUIRED");
  return roles as WorkerRole[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("WORKER_CONFIGURATION_INVALID");
  return parsed;
}

export function createDurableWorkerRuntime() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const database = createPostgresDatabase(databaseUrl);
  const authorization = new PostgresAuthorizationResolver(database);
  const connectors = createIdentityConnectorRegistry(database);
  const channelContexts = new PostgresChannelActorContextResolver(database, authorization);
  const channelActions = new AgentChannelActionHandler(connectors, channelContexts, getAgentOrchestrator(), getTaskCommandService());
  const managementChannelActions = new ManagementChannelActionHandler(connectors, channelContexts, createManagementIntelligenceService(database));
  const events = new PostgresEventStore(database);
  const roles = workerRoles();
  const leaseMs = positiveInteger(process.env.WORKER_LEASE_MS, 30_000);
  const maxTenantConcurrency = positiveInteger(process.env.WORKER_MAX_CONCURRENT_PER_TENANT, 2);
  const workers = new Map<WorkerRole, TenantWorker>([
    ["inbox", new InboxWorker(new PostgresInboxWorkRepository(database), new DurableInboundEventHandler(channelActions, events, managementChannelActions), leaseMs, maxTenantConcurrency)],
    ["agent", new AgentJobWorker(new PostgresAgentJobRepository(database), authorization, new ManagementContextProvider(getManagementLoopService()), getAgentToolRegistry(), leaseMs, maxTenantConcurrency)],
    ["outbox", new OutboxDispatcher(new PostgresOutboxWorkRepository(database), leaseMs, maxTenantConcurrency)],
  ]);
  if (roles.includes("pi-change-delivery")) {
    const workspaceService = new PiWorkspaceService({
      store: new PostgresPiWorkspaceStore(database),
      provider: createPiWorkspaceProvider(),
      credentialBroker: createPiGitCredentialBroker(),
      objectStorage: createPiObjectStorageGateway(),
      sessionStore: new PostgresPiSessionStore(database),
    });
    const changeStore = new PostgresPiChangeDeliveryStore(database);
    const evidence = {
      getRepository: workspaceService.getRepository.bind(workspaceService),
      getWorkspace: workspaceService.getWorkspace.bind(workspaceService),
      deliveryDiff: workspaceService.deliveryDiff.bind(workspaceService),
      checkpoints: workspaceService.checkpoints.bind(workspaceService),
      listArtifacts: workspaceService.listArtifacts.bind(workspaceService),
    };
    const approvals = new PiApprovalService(
      new PostgresPiApprovalStore(database),
      new ApprovalPolicyResolver(new FailClosedPiApprovalApproverDirectory(), { policyVersion: 1 }),
      new PostgresPiApprovalEventSink(database),
      new PiChangeDeliveryApprovalObjectVersionReader(changeStore, evidence),
    );
    const gateways = createPiChangeDeliveryGateways();
    const changeDelivery = new PiChangeDeliveryService(
      changeStore,
      evidence,
      approvals,
      gateways.pullRequests,
      gateways.releases,
      positiveInteger(process.env.PI_CHANGE_DELIVERY_LEASE_MS, 60_000),
    );
    workers.set("pi-change-delivery", new PiChangeDeliveryOutboxWorker(changeDelivery, positiveInteger(process.env.PI_CHANGE_DELIVERY_WORKER_BATCH, 1), gateways.enabled));
  }
  const enabled = roles.map((role) => workers.get(role)!);
  const supervisor = new WorkerSupervisor(
    new PostgresTenantDirectory(database),
    new PostgresWorkerHeartbeatRepository(database),
    enabled,
    {
      instanceId: process.env.WORKER_INSTANCE_ID ?? `${process.pid}-${randomUUID().slice(0,8)}`,
      releaseVersion: process.env.NEXUS_RELEASE_VERSION ?? "0.15.0-pi-runner-spike",
      pollIntervalMs: positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 500),
      heartbeatIntervalMs: positiveInteger(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10_000),
      maxItemsPerRolePerCycle: positiveInteger(process.env.WORKER_MAX_ITEMS_PER_ROLE, 32),
    },
  );
  return { database, supervisor, roles };
}
